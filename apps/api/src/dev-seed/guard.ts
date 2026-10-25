/** The database name suffixes the dev seed accepts: a local or throwaway database only. */
export const SEED_DATABASE_SUFFIXES = ['_dev', '_test'] as const;

/**
 * Why the dev seed must not run against this environment, or null when it may (handoff 35;
 * Hassan's condition for seed data: never in production). Both conditions must hold:
 *
 * - `NODE_ENV` is set explicitly to `development` or `test` (an unset one is refused, as the
 *   mail catcher refuses it, so a deployment that forgets the variable fails closed);
 * - the database named by `DATABASE_URL` ends in `_dev` or `_test`, so a seed pointed at a
 *   shared or deployed database by a mistyped variable refuses before it connects.
 *
 * The answer names variables, never their values (the URL holds a password).
 */
export function devSeedRefusal(env: NodeJS.ProcessEnv): string | null {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    return 'NODE_ENV must be set to development or test; the dev seed never runs elsewhere';
  }
  const name = databaseNameOf(env.DATABASE_URL);
  if (name === null) return 'DATABASE_URL is missing or not a postgresql:// URL';
  if (!SEED_DATABASE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return `the database in DATABASE_URL must end in ${SEED_DATABASE_SUFFIXES.join(' or ')}`;
  }
  return null;
}

/** The database name of a PostgreSQL URL, or null when it is not one. */
export function databaseNameOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null;
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return name.length > 0 && !name.includes('/') ? name : null;
}
