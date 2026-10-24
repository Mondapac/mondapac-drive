import { exemption } from '../../../platform/health/health.controller';

// Violation: a module imports nothing from platform/health/, so it cannot copy the exemption.
export const violation = exemption;
