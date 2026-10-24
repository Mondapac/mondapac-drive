import { nearestCouriers } from '../../tracking/contracts/courier-positions.contract';

// Violation: only dispatch may import tracking's ungated courier positions.
export const near = nearestCouriers;
