import { APPROVED_SELLER_ZONES } from '../../sellers/contracts/approved-seller-zones.contract';

// Violation: only certification's application layer may import sellers' approved-seller-zones
// contract.
export const token = APPROVED_SELLER_ZONES;
