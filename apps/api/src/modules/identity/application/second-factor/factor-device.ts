import type { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import { parsePresentedCode } from './code-check';
import type { SignedInFactorDependencies, SignedInFactorRefusal } from './signed-in-factor-step';
import type { FieldProblem } from '../field-problem';

// What the three device use cases of an admin's own second factor share (slice 7b item E): the
// code input, the failure union, the dependencies, the code field check and the outcome log.

/** A code typed by the signed-in holder. */
export interface FactorCodeInput {
  readonly code: string;
}

export type FactorStepFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | SignedInFactorRefusal;

export interface FactorDeviceDependencies extends SignedInFactorDependencies {
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
}

export const codeField = (raw: string, allowRecovery: boolean) => {
  const presented = parsePresentedCode(raw, allowRecovery);
  return presented === null
    ? err({ code: 'validation.failed' as const, fields: [{ path: 'code', code: 'format' }] })
    : ok(presented);
};

/** Codes only, never a code, a secret or a token (P 12.3). */
export function logOutcome(
  logger: Logger,
  msg: string,
  context: CallContext,
  outcome: string,
): void {
  const actor = context.actor;
  logger.log({
    msg,
    outcome,
    ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
