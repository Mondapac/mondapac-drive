import { ok } from '@mondapac-drive/shared-kernel';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AccessDecision,
  AccessDeclaration,
  AuthorisationCheck,
} from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type {
  MerchantMembershipRepository,
  MerchantRepository,
} from '../ports/merchant.repository';
import { holdsEvery, type EffectiveKeyResolver } from './effective-keys';

const ALLOWED: AccessDecision = Object.freeze({ allowed: true });
const DENIED: AccessDecision = Object.freeze({
  allowed: false,
  denial: Object.freeze({ code: 'access.denied' }),
});

export interface AccountAuthorisationCheckDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly memberships: Pick<MerchantMembershipRepository, 'findActiveByAccount'>;
  readonly merchants: Pick<MerchantRepository, 'findById'>;
  /** The account's role, read in the check's own read-only unit. */
  readonly grants: RoleGrantReader;
  /**
   * The effective-key resolver: in production the one bound to `EFFECTIVE_KEY_RESOLVER`,
   * `effectiveKeysOf` over the permission registry, which the actor summary takes too (N-1).
   */
  readonly effectiveKeys: EffectiveKeyResolver;
}

/**
 * identity's {@link AuthorisationCheck} (identity design 5.2; platform-foundations 6.3). The gate
 * calls it for an authenticated actor under `own-resources` or `permissions`. It reads committed
 * state on each call, in one read-only unit of its own and never inside the caller's (PN3), and
 * caches nothing (R4):
 *
 * - the account exists in the actor's Market, has the actor's population and is active;
 * - for the merchant population: the account's active membership is of the actor's merchant,
 *   and that merchant exists and is `active` (a suspended merchant's keys are revoked as well,
 *   so this is the second line);
 * - `own-resources`: then allowed;
 * - `permissions` allowed only when the actor holds every listed key. The keys are
 *   `effectiveKeysOf` the account's role (its assignment, read in the same unit) over the
 *   permission registry: a key the registry does not declare, or declares in another scope than
 *   the population's, is never held (R2, R7), so no separate scope test can disagree with it.
 *
 * An exception propagates; the gate turns it into `access.unavailable` (fail closed).
 */
export class AccountAuthorisationCheck implements AuthorisationCheck {
  constructor(private readonly deps: AccountAuthorisationCheckDependencies) {}

  async check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return DENIED;
    const rule = declaration.rule;
    if (rule.kind !== 'own-resources' && rule.kind !== 'permissions') return DENIED;
    const required = rule.kind === 'permissions' ? rule.allOf : null;
    const merchant = actor.population === 'merchant';
    if (merchant !== (actor.merchantId !== null)) return DENIED;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          membership: merchant
            ? await this.deps.memberships.findActiveByAccount(market, actor.accountId)
            : null,
          business:
            actor.merchantId === null
              ? null
              : await this.deps.merchants.findById(market, actor.merchantId),
          grant:
            required === null
              ? null
              : ((await this.deps.grants.grantsOf(market, [actor.accountId])).get(
                  actor.accountId,
                ) ?? null),
        }),
      { readOnly: true },
    );
    if (!read.ok) return DENIED;
    const { account, membership, business, grant } = read.value;
    if (
      account === null ||
      account.state.marketId !== market.marketId ||
      account.state.population !== actor.population ||
      account.state.status !== 'active'
    ) {
      return DENIED;
    }
    if (
      merchant &&
      (membership === null ||
        membership.merchantId !== actor.merchantId ||
        business === null ||
        !business.isActive)
    ) {
      return DENIED;
    }
    if (required === null) return ALLOWED;
    const held = this.deps.effectiveKeys({
      population: actor.population,
      accountId: actor.accountId,
      merchantId: actor.merchantId,
      grant,
    });
    return holdsEvery(held, required) ? ALLOWED : DENIED;
  }
}
