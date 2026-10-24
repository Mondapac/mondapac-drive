import { DatabaseProbe } from './persistence/database-probe';

// Allowed: the connectivity probe is the public face of platform/persistence.
export const allowed = new DatabaseProbe();
