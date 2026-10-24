import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Id, Result } from '@mondapac-drive/shared-kernel';

export type LastHolder = { readonly code: 'member.last-holder' };

/**
 * `LastHolderPolicy` (identity design 5.5; R3, AC 25): a pure domain service. Before a removal,
 * a demotion or a disabling, the caller counts the holders of the system role in the scope (the
 * Market's platform scope) that are `active` and have a verified email ("can sign
 * in"), and passes their ids; the change is refused when it would leave none.
 *
 * The count is only as good as the unit it is read in: every use case that applies this policy,
 * and every writer of `role_assignments` or `accounts.status`, runs
 * its unit `serializable` (5.5, HF8; data design 5.1), so of two concurrent demotions one is
 * retried and then refused.
 */
export const LastHolderPolicy = Object.freeze({
  /** True when losing `accountId` leaves the scope without a holder who can sign in. */
  wouldLeaveNoHolder(holders: readonly Id<'Account'>[], accountId: Id<'Account'>): boolean {
    const distinct = new Set(holders);
    return distinct.has(accountId) && distinct.size === 1;
  },

  /** `member.last-holder` when {@link wouldLeaveNoHolder}; otherwise allowed. */
  allowsLosing(
    holders: readonly Id<'Account'>[],
    accountId: Id<'Account'>,
  ): Result<void, LastHolder> {
    return LastHolderPolicy.wouldLeaveNoHolder(holders, accountId)
      ? err({ code: 'member.last-holder' })
      : ok(undefined);
  },
});
