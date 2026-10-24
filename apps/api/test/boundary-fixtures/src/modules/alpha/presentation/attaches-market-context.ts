import { attachMarketContext } from '../../../platform/market-context/market.decorator';

// Violation: only MarketContextGuard attaches a request's MarketContext.
export const violation = attachMarketContext;
