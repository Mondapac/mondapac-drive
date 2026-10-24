import { NoMarketContext } from '../market-context/no-market-context.decorator';

// Allowed: health is exempt from Market resolution.
export const exemption = NoMarketContext();
