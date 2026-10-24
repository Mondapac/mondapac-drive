import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { RoleGrant } from '../access/effective-keys';

/**
 * The grant read of the key rule (identity design 5.2, 8.7; slice 8a-1): for each account, the
 * role of its one assignment (Phase 2), with the role's scope, kind, seller and stored keys. An
 * account without an assignment is absent from the answer. Runs in the caller's open unit,
 * which is read-only for the gate and the reviewer read, and takes the `MarketContext` only:
 * single-table reads of `role_assignments`, `roles` and `role_permissions`, no join (R8). No
 * cache: the gate reads it on every call (R4; ADR-0018 decision 2).
 */
export interface RoleGrantReader {
  grantsOf(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, RoleGrant>>;
}

/** Nest token of the {@link RoleGrantReader}. */
export const ROLE_GRANT_READER = Symbol('ROLE_GRANT_READER');
