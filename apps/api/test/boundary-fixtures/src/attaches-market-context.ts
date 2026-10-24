import { attachMarketContext } from './platform/market-context/market.decorator';

// Violation: the composition root does not attach a MarketContext either.
export const violation = attachMarketContext;
