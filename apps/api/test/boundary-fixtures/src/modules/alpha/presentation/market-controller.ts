import { Market } from '../../../platform/market-context/market.decorator';

// Allowed: a module reads its Market with @Market(), the one import it may make from
// platform/market-context/.
export const allowed = Market;
