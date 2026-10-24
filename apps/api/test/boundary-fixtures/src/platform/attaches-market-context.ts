import { attachMarketContext } from './market-context/market.decorator';
import * as decorators from './market-context/market.decorator';

// Violations: only MarketContextGuard attaches a request's MarketContext.
export const violation = [attachMarketContext, decorators.attachMarketContext];
