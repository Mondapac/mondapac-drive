import { NoMarketContext } from '../../../platform/market-context/no-market-context.decorator';

// Violation: only health and docs are exempt from Market resolution.
export const violation = NoMarketContext();
