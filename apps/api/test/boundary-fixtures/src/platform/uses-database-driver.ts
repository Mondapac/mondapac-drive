import { Pool } from 'pg';

// Violation: only infrastructure/ and platform/persistence/ use the database driver.
export const violation = Pool;
