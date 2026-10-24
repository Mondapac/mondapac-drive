import { reserve } from '../../inventory/contracts/ordering-port';

// Violation: only ordering may import inventory's ordering port.
export const hold = reserve;
