import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';

/**
 * One admin account as the admin team list shows it (identity design 8.6 rows 2 and 6; slice
 * 8c). The address and the name are personal data: they go to the actor entitled to see them
 * (`identity.admin-account.view`), never to a log, an event or an audit row. Never the
 * credential.
 */
export interface AdminAccountSummary {
  readonly accountId: Id<'Account'>;
  /** As typed. */
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
}

/**
 * The SQL read of the admin team list (slice 8c). Runs in the caller's open unit (read-only) and
 * takes the `MarketContext` only.
 */
export interface AdminAccountReader {
  /**
   * Up to `limit` accounts of the `admin` population in this Market whose id is greater than
   * `after` (all when null), by id.
   */
  adminAccounts(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<AdminAccountSummary[]>;

  /** The same read of the `courier` population (Drive's courier list). */
  courierAccounts(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<AdminAccountSummary[]>;
}

/** Nest token of the {@link AdminAccountReader}. */
export const ADMIN_ACCOUNT_READER = Symbol('ADMIN_ACCOUNT_READER');
