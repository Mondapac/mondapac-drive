import { Logger } from '@nestjs/common';
import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type {
  MerchantMembershipRepository,
  MerchantRepository,
} from '../ports/merchant.repository';
import type { SessionTokens } from '../ports/session-secrets';
import type { SessionRepository } from '../ports/session.repository';
import { readActingGrants, type ActingGrantDependencies } from '../roles/granting';

/** The ports every merchant use case reads; each takes the ones it needs. */
export interface MerchantAdminDependencies extends ActingGrantDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly merchants: MerchantRepository;
  readonly memberships: MerchantMembershipRepository;
  readonly sessions: SessionRepository;
  readonly sessionTokens: SessionTokens;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type MerchantAdminRefusal =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

const logger = new Logger('MerchantAdmin');

/**
 * Runs `work` in one unit for a signed-in admin who, read again in that unit, is still an active,
 * verified admin holding every key of `ruleKeys` (Mohammad C1 on the marketplace's PR #187: the
 * gate checked in an earlier unit). A stale write answers `access.unavailable`; the operator
 * retries. Logs the outcome code with ids only, never a merchant's name or a key.
 */
export async function asActingAdmin<T, F extends { readonly code: string }>(
  deps: MerchantAdminDependencies,
  context: CallContext,
  msg: string,
  ruleKeys: readonly string[],
  work: () => Promise<Result<T, F>>,
  fields: (value: T) => Record<string, string> = () => ({}),
): Promise<Result<T, F | MerchantAdminRefusal>> {
  const { market, actor } = context;
  let result: Result<T, F | MerchantAdminRefusal>;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    result = err({ code: 'access.denied' });
  } else {
    const self = { accountId: actor.accountId, population: 'admin' as const };
    try {
      result = await deps.unitOfWork.run(
        market,
        async (): Promise<Result<T, F | MerchantAdminRefusal>> => {
          const reading = await readActingGrants(deps, market, self, [], ruleKeys);
          if (reading === null) return err({ code: 'access.denied' });
          return work();
        },
      );
    } catch (error) {
      if (!(error instanceof StaleAggregateError)) throw error;
      result = err({ code: 'access.unavailable' });
    }
  }
  logger.log({
    msg,
    outcome: result.ok ? 'ok' : result.error.code,
    ...(result.ok ? fields(result.value) : {}),
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}
