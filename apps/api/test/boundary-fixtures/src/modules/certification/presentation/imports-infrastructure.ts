import { token } from '../infrastructure/reads-approved-seller-zones';

// Violation: certification's presentation must not import its infrastructure (the adapter).
export const reexported = token;
