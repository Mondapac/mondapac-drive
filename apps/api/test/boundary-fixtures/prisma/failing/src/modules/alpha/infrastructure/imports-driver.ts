// Violation: a database driver outside the platform files.
import { Pool } from 'pg';

export const pool = Pool;
