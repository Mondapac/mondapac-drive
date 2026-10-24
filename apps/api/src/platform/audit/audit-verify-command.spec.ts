import { err, ok } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import {
  AUDIT_VERIFY_EXIT,
  AUDIT_VERIFY_USAGE,
  failureLine,
  parseAuditVerifyArguments,
  runAuditVerifyCommand,
} from './audit-verify-command';
import { AuditVerifier, type VerifyReport } from './audit-verifier';

// The operator command `audit-verify --market <id> [--full]` (docs/design/domain/platform-audit.md
// 8): its arguments, its exit codes, and an output with positions and codes only.

describe('parseAuditVerifyArguments', () => {
  it.each([
    [['--market', 'AU'], { marketId: 'AU', full: false }],
    [['--full', '--market', 'ZZ'], { marketId: 'ZZ', full: true }],
    [['--market', 'AU', '--full'], { marketId: 'AU', full: true }],
  ])('reads %j', (argv, expected) => {
    expect(parseAuditVerifyArguments(argv)).toEqual(ok(expected));
  });

  it.each([
    [[]],
    [['--full']],
    [['--market']],
    [['--market', '']],
    [['--market', 'AU', '--market', 'ZZ']],
    [['--market', 'AU', '--full', '--full']],
    [['--market', 'AU', 'extra']],
    [['--market=AU']],
  ])('refuses %j', (argv) => {
    expect(parseAuditVerifyArguments(argv)).toEqual(err('usage'));
  });
});

describe.each(TEST_MARKETS)('runAuditVerifyCommand for market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  function appWith(report: Partial<VerifyReport>, failure: Error | null = null) {
    const calls: [MarketContext, string, string][] = [];
    const verifier = {
      verify: (
        context: { market: MarketContext; actor: { kind: string }; correlationId: string },
        mode: string,
      ) => {
        calls.push([context.market, mode, context.actor.kind]);
        if (failure !== null) return Promise.reject(failure);
        return Promise.resolve({
          marketId: context.market.marketId,
          mode,
          pinnedHead: 4n,
          fromSeq: 1n,
          sealsChecked: 4,
          lateSeals: 0,
          findings: [],
          findingTotals: {},
          totalsAtLeast: [],
          complete: true,
          ...report,
        });
      },
    };
    const factory = {
      forMarket: (requested: string) =>
        requested === code ? ok(market) : err({ code: 'market.not-hosted' }),
    };
    const ids = new SequenceIdGenerator(
      new FixedClock(Temporal.Instant.from('2026-10-08T06:00:00Z')),
    );
    const app = {
      get: (token: unknown) =>
        token === AuditVerifier
          ? verifier
          : token === MarketContextFactory
            ? factory
            : token === ID_GENERATOR
              ? ids
              : undefined,
    } as unknown as INestApplicationContext;
    return { app, calls };
  }

  it('runs an incremental verification as the system actor and exits 0 with no finding', async () => {
    const { app, calls } = appWith({});
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', code],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.clean);
    expect(calls).toEqual([[market, 'incremental', 'system']]);
    expect(JSON.parse(lines[0]!)).toEqual({
      marketId: code,
      mode: 'incremental',
      pinnedHead: '4',
      fromSeq: '1',
      sealsChecked: 4,
      lateSeals: 0,
      complete: true,
      findingTotals: {},
      totalsAtLeast: [],
      findings: [],
    });
    expect(errors).toEqual([]);
  });

  it('runs a full verification with --full and exits 2 with findings, positions only', async () => {
    const { app, calls } = appWith({
      findings: [
        {
          code: 'audit.row.mismatch',
          marketId: code,
          epoch: 1,
          chainSeq: 2n,
          auditLogId: '01990000-0000-7000-8000-000000000002',
        },
      ],
    });
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', code, '--full'],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.findings);
    expect(calls[0]![1]).toBe('full');
    expect((JSON.parse(lines[0]!) as { findings: unknown }).findings).toEqual([
      {
        code: 'audit.row.mismatch',
        epoch: 1,
        chainSeq: '2',
        auditLogId: '01990000-0000-7000-8000-000000000002',
      },
    ]);
  });

  it('refuses a usage error and a Market this stack does not host, without echoing it', async () => {
    const { app, calls } = appWith({});
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market'],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.refused);
    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', 'XX<script>'],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.refused);
    expect(lines[0]).toBe(AUDIT_VERIFY_USAGE);
    expect(lines[1]).not.toContain('XX');
    expect(calls).toEqual([]);
  });

  it('exits 2 when an incomplete run already found something: a finding wins (Mohammad C2)', async () => {
    const { app } = appWith({
      complete: false,
      findings: [
        {
          code: 'audit.chain.broken',
          marketId: code,
          epoch: 1,
          chainSeq: 7n,
          auditLogId: '01990000-0000-7000-8000-000000000007',
        },
      ],
    });
    const lines: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', code],
        (l) => lines.push(l),
        (l) => lines.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.findings);
    expect((JSON.parse(lines[0]!) as { complete: boolean }).complete).toBe(false);
  });

  it('exits 3 when the verification ran out of its budget, with the report written', async () => {
    const { app } = appWith({ complete: false });
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', code],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.incomplete);
    expect((JSON.parse(lines[0]!) as { complete: boolean }).complete).toBe(false);
  });

  it('exits 3 when the verification throws, printing the class and SQLSTATE, never the message (Mohammad 8)', async () => {
    const secret = 'Key (id)=(01990000-0000-7000-8000-00000000beef) value "amina@example.com"';
    const databaseError = Object.assign(new Error(secret), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '57014', originalMessage: secret } } },
    });
    const { app } = appWith({}, databaseError);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      runAuditVerifyCommand(
        app,
        ['--market', code, '--full'],
        (l) => lines.push(l),
        (l) => errors.push(l),
      ),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.incomplete);
    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^audit-verify: the verification did not complete \(PrismaClientKnownRequestError/,
    );
    expect(errors[0]).not.toContain('amina');
    expect(errors[0]).not.toContain('beef');
  });

  it('names a non-identifier error class as Error', () => {
    const odd = Object.assign(new Error('x'), { name: 'a b <c>' });
    expect(failureLine(odd)).toBe('audit-verify: the verification did not complete (Error)');
    expect(failureLine('not an error', 'the start failed')).toBe(
      'audit-verify: the start failed (Error)',
    );
  });
});
