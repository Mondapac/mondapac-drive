import { betaFacade } from '../../beta';

// Allowed: catalog may import another module (here beta) through its index.ts.
export const allowed = betaFacade;
