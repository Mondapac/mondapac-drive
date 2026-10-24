export { betaFacade } from './contracts';
// Violation (use-cases-are-the-only-way-in, L2): the module's index.ts is an entry point too;
// it re-exports nothing of application/ but a use case.
export { betaService } from './application/beta.service';
