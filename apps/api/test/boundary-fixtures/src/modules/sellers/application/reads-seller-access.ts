import { sellerAccessOf } from '../../identity/contracts/seller-access.contract';

// Allowed: sellers consumes identity's seller-access contract (ADR-0022 decision 6).
export const read = sellerAccessOf;
