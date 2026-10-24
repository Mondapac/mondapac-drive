import { mintMarketContext } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';

// Allowed: the platform factory is the one place that mints a MarketContext.
export class MarketContextFactory {
  forMarket(marketId: string): MarketContext {
    return mintMarketContext(marketId, 'mondapac');
  }
}
