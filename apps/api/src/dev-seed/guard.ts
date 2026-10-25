/** The database name suffixes the dev seed accepts: a local or throwaway database only. */
export const SEED_DATABASE_SUFFIXES = ['_dev', '_test'] as const;

/** Hosts the seed's database and Redis may be on without DEV_SEED_ALLOWED_HOSTS. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The variables of providers that reach the outside world (SMS, push, payments, maps). The seed
 * removes them from its own environment before the application boots, so a developer's real
 * keys in `.env` never send an SMS or a payout for seed data (Hassan M1, PR #42). The Market's
 * routing key variables (`routing.*.apiKeyEnv`) are removed too.
 */
export const OUTBOUND_PROVIDER_VARIABLES = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRETS',
  'EXPO_ACCESS_TOKEN',
  'GOOGLE_MAPS_API_KEY',
] as const;

/** Deletes every outbound provider variable, and `extra` ones, from `env`. */
export function dropOutboundProviders(env: NodeJS.ProcessEnv, extra: readonly string[] = []): void {
  for (const name of [...OUTBOUND_PROVIDER_VARIABLES, ...extra]) delete env[name];
}

/**
 * Why the dev seed must not run against this environment, or null when it may (handoff 35;
 * Hassan's condition for seed data: never in production). Every condition must hold:
 *
 * - `NODE_ENV` is set explicitly to `development` or `test` (an unset one is refused, as the
 *   mail catcher refuses it, so a deployment that forgets the variable fails closed);
 * - the database named by `DATABASE_URL` ends in `_dev` or `_test`, so a seed pointed at a
 *   shared or deployed database by a mistyped variable refuses before it connects;
 * - that database, and Redis when set, are on a loopback host or one named in
 *   `DEV_SEED_ALLOWED_HOSTS` (Hassan L1: a remote `*_test` database is refused).
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
  const allowed = new Set([
    ...LOOPBACK,
    ...(env.DEV_SEED_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (!allowed.has(hostOf(env.DATABASE_URL) ?? '')) {
    return 'the DATABASE_URL host must be local, or listed in DEV_SEED_ALLOWED_HOSTS';
  }
  if ((env.REDIS_URL ?? '') !== '' && !allowed.has(hostOf(env.REDIS_URL) ?? '')) {
    return 'the REDIS_URL host must be local, or listed in DEV_SEED_ALLOWED_HOSTS (or unset)';
  }
  return null;
}

function hostOf(url: string | undefined): string | null {
  try {
    return url === undefined ? null : new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
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
