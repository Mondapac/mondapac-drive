import { mint } from './minted';
import type { Minted } from './minted';
import { err, ok } from './result';
import type { Result } from './result';

/** The code of a Market. It fits `market_id varchar(8)`. */
export type MarketId = string & { readonly __brand: 'MarketId' };

/** The id of a tenant. A seam only (ADR-0001 decision 2): it isolates nothing. */
export type TenantId = string & { readonly __brand: 'TenantId' };

/**
 * The Market and the tenant a piece of work belongs to (ADR-0008 decision 5): both present,
 * well formed, immutable and minted. There is no default Market.
 *
 * It holds nothing else: locale, currency and time zone are Market configuration, read by
 * `marketId`. The kernel guarantees the shape only; "hosted by this Region Stack" is the
 * guarantee of the single production constructor in the platform.
 */
export interface MarketContext extends Minted<'MarketContext'> {
  readonly marketId: MarketId;
  readonly tenantId: TenantId;
}

// The single definitions of the two rules. The database repeats them as CHECK constraints.
const MARKET_ID = /^[A-Z][A-Z0-9_]{1,7}$/;
const TENANT_ID = /^[a-z][a-z0-9-]{1,31}$/;

export function parseMarketId(
  text: string,
): Result<MarketId, { readonly code: 'market-id.invalid' }> {
  // The run-time type check matters: RegExp.test() would turn an array into a string.
  if (typeof text !== 'string' || !MARKET_ID.test(text)) {
    return err({ code: 'market-id.invalid' });
  }
  return ok(text as MarketId);
}

export function parseTenantId(
  text: string,
): Result<TenantId, { readonly code: 'tenant-id.invalid' }> {
  if (typeof text !== 'string' || !TENANT_ID.test(text)) {
    return err({ code: 'tenant-id.invalid' });
  }
  return ok(text as TenantId);
}

/**
 * Mints the context of one Market. Called by the platform's market-context factory only;
 * tests use the builder on the `/testing` entry.
 *
 * It takes parsed values and cannot fail for them. The brands are compile-time only, so the
 * patterns are checked again here: a value forced through a type assertion is a programmer
 * error and throws, which keeps "minted" meaning "well formed".
 */
export function mintMarketContext(marketId: MarketId, tenantId: TenantId): MarketContext {
  if (!parseMarketId(marketId).ok || !parseTenantId(tenantId).ok) {
    throw new TypeError('mintMarketContext: the market id and tenant id must be parsed values');
  }
  return mint<MarketContext>({ marketId, tenantId });
}
