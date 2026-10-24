import { sellerAccessOf } from '../../identity/contracts/seller-access.contract';

// Violation: only the sellers module may import identity's seller-access contract.
export const read = sellerAccessOf;
