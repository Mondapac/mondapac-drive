import { betaFacade } from '../modules/beta';

// Violation: platform/ may not import a module, not even through its index.ts.
export const violation = betaFacade;
