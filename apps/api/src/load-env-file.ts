import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { MIGRATION_DATABASE_URL } from './platform/config/app-config';

/**
 * Loads the repository's `.env` file for local development, if there is one. Variables
 * already set in the environment win, so deployed environments are unaffected.
 *
 * The local `.env` also holds the migration role's URL for `pnpm db:*` and the tests; the
 * application skips it, so it never receives that URL (docs/design/data/platform.md 10.7).
 */
export function loadEnvFile(
  // apps/api/{src|dist} -> repository root
  file: string = path.resolve(__dirname, '../../../.env'),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (key === MIGRATION_DATABASE_URL || key in env) continue;
    env[key] = value;
  }
}
