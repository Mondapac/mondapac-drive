import type { INestApplicationContext } from '@nestjs/common';
import { err, ok, parseCorrelationId } from '@mondapac-drive/shared-kernel';
import type { IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import { createCallContext, systemActor } from '@mondapac-drive/shared-kernel/contexts';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { reduceDatabaseError } from '../persistence/database-error';
import { AuditVerifier, type VerifyReport } from './audit-verifier';

/** The arguments of `audit-verify --market <id> [--full]` (docs/design/domain/platform-audit.md 8). */
export interface AuditVerifyArguments {
  readonly marketId: string;
  readonly full: boolean;
}

/** The exit codes of the command. */
export const AUDIT_VERIFY_EXIT = Object.freeze({
  /** Verified, no finding. */
  clean: 0,
  /** A usage error, a Market this stack does not host, or a failed start. */
  refused: 1,
  /**
   * At least one finding (each is also an alert line in the log), whether or not the run
   * completed: a finding wins over an incomplete run (Mohammad, round 2 C2).
   */
  findings: 2,
  /**
   * The verification did not complete and found nothing before it stopped: its budget ran out
   * (`audit.verify.incomplete`) or an error stopped it after the start-up checks (Mohammad 8,
   * Hassan L4). The part after the stop was not checked; any findings listed are valid.
   */
  incomplete: 3,
});

export const AUDIT_VERIFY_USAGE = 'usage: audit-verify --market <id> [--full]';

/** Reads the command line; anything but exactly one `--market <id>` and an optional `--full` is refused. */
export function parseAuditVerifyArguments(
  argv: readonly string[],
): Result<AuditVerifyArguments, 'usage'> {
  let marketId: string | undefined;
  let full = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--full' && !full) {
      full = true;
    } else if (argument === '--market' && marketId === undefined && index + 1 < argv.length) {
      marketId = argv[index + 1];
      index += 1;
    } else {
      return err('usage');
    }
  }
  return marketId === undefined || marketId.length === 0 ? err('usage') : ok({ marketId, full });
}

/** The command's output: positions and codes, never row content (PA 8). */
export function describeReport(report: VerifyReport): string {
  return JSON.stringify({
    marketId: report.marketId,
    mode: report.mode,
    pinnedHead: report.pinnedHead === null ? null : String(report.pinnedHead),
    fromSeq: report.fromSeq === null ? null : String(report.fromSeq),
    sealsChecked: report.sealsChecked,
    lateSeals: report.lateSeals,
    complete: report.complete,
    findingTotals: report.findingTotals,
    totalsAtLeast: report.totalsAtLeast,
    findings: report.findings.map((finding) => ({
      code: finding.code,
      epoch: finding.epoch,
      chainSeq: finding.chainSeq === null ? null : String(finding.chainSeq),
      auditLogId: finding.auditLogId,
    })),
  });
}

/**
 * The operator command `audit-verify --market <id> [--full]` of the api image (PA 8; the
 * pattern of identity design 7.4): the named Market's context from the factory (a Market this
 * stack does not host is refused), the system actor and a new correlation id, then one
 * verification, incremental unless `--full`. It reads only and writes nothing, so it needs no
 * operator log (PA 9.2 covers the commands that act as `SYSTEM`). Answers the exit code and
 * writes one JSON line through `write`; a failure writes one fixed line through `writeError`
 * with the error's class and SQLSTATE only, never its message (Mohammad 8).
 */
export async function runAuditVerifyCommand(
  app: INestApplicationContext,
  argv: readonly string[],
  write: (line: string) => void,
  writeError: (line: string) => void,
): Promise<number> {
  const parsed = parseAuditVerifyArguments(argv);
  if (!parsed.ok) {
    write(AUDIT_VERIFY_USAGE);
    return AUDIT_VERIFY_EXIT.refused;
  }
  const market = app.get(MarketContextFactory).forMarket(parsed.value.marketId);
  const correlationId = parseCorrelationId(
    app.get<IdGenerator>(ID_GENERATOR).next<'audit-verify'>(),
  );
  if (!market.ok || !correlationId.ok) {
    // The operator's input is not echoed.
    write('audit-verify: that Market is not hosted by this stack');
    return AUDIT_VERIFY_EXIT.refused;
  }
  const context = createCallContext(market.value, systemActor(market.value), correlationId.value);
  let report: VerifyReport;
  try {
    report = await app
      .get(AuditVerifier)
      .verify(context, parsed.value.full ? 'full' : 'incremental');
  } catch (error) {
    writeError(failureLine(error));
    return AUDIT_VERIFY_EXIT.incomplete;
  }
  write(describeReport(report));
  if (report.findings.length > 0) return AUDIT_VERIFY_EXIT.findings;
  return report.complete ? AUDIT_VERIFY_EXIT.clean : AUDIT_VERIFY_EXIT.incomplete;
}

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * One fixed line for an error: its class name and, for a database error, its SQLSTATE. A
 * driver or Prisma message can quote values, so it is never printed (Mohammad 8).
 */
export function failureLine(error: unknown, what = 'the verification did not complete'): string {
  const name = error instanceof Error && CLASS_NAME.test(error.name) ? error.name : 'Error';
  const sqlState = reduceDatabaseError(error)?.sqlState;
  return `audit-verify: ${what} (${name}${sqlState === undefined ? '' : `, SQLSTATE ${sqlState}`})`;
}
