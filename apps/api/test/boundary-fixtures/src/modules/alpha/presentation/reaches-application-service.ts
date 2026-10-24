import { thingService } from '../application/thing.service';

// Violation (use-cases-are-the-only-way-in): a controller imports from application/ only
// use-cases/*.use-case.ts, so the access gate runs for everything it reaches.
export const violation = thingService;
