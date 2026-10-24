import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketConfig } from './market-config';

/**
 * Thrown by `get()` for a Market this Region Stack does not host. For configuration-time
 * callers; a request, job or event is refused through `MarketContextFactory` instead.
 */
export class MarketNotHostedError extends Error {
  constructor(readonly marketId: MarketId) {
    super(`Market "${marketId}" is not hosted by this Region Stack`);
    this.name = 'MarketNotHostedError';
  }
}

/**
 * The Markets this Region Stack serves (ADR-0003). There is no default market: callers
 * always name the market, and a market outside HOSTED_MARKETS is rejected.
 *
 * It takes parsed Market ids and mints nothing: `MarketContextFactory` is the only
 * constructor of a `MarketContext` (platform-foundations 5.1).
 */
export class MarketRegistry {
  constructor(private readonly markets: ReadonlyMap<MarketId, MarketConfig>) {}

  /** Codes of all hosted markets, in HOSTED_MARKETS order. */
  hostedMarketIds(): readonly MarketId[] {
    return [...this.markets.keys()];
  }

  isHosted(marketId: MarketId): boolean {
    return this.markets.has(marketId);
  }

  /** @throws MarketNotHostedError when the market is not hosted here (residency guard). */
  get(marketId: MarketId): MarketConfig {
    const market = this.markets.get(marketId);
    if (market === undefined) throw new MarketNotHostedError(marketId);
    return market;
  }
}
