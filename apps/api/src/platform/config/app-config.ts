import path from 'node:path';
import { parseMarketId } from '@mondapac-drive/shared-kernel';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { parseClientAddressTrust, type ClientAddressTrust } from '../http/client-address-trust';

// apps/api/{src|dist}/platform/config -> repository root
const DEFAULT_MARKET_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/markets');
const DEFAULT_SERVICE_AREA_CONFIG_DIR = path.resolve(
  __dirname,
  '../../../../../config/service-areas',
);
const DEFAULT_LOCALE_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/locales');

/** A Market code as used in `market_id` columns (ADR-0004), by the kernel's single rule. */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

const hostedMarkets = z
  .string({ error: 'HOSTED_MARKETS is required; there is no default market (ADR-0003)' })
  .transform((value) =>
    value
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0),
  )
  .pipe(z.array(marketCode).min(1, 'HOSTED_MARKETS must list at least one market'))
  .refine((codes) => new Set(codes).size === codes.length, 'HOSTED_MARKETS has duplicates');

/** The two process roles (platform persistence design 8; ADR-0006 decision 4, ADR-0008 decision 1). */
export const APP_ROLES = ['api', 'worker'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const envSchema = z.object({
  // Required, no default (PA7): a worker that silently started as `api` would relay nothing.
  APP_ROLE: z.enum(APP_ROLES, {
    error: 'APP_ROLE is required and must be "api" or "worker"; there is no default',
  }),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOSTED_MARKETS: hostedMarkets,
  API_DOCS_ENABLED: z.enum(['true', 'false']).default('false'),
  MARKET_CONFIG_DIR: z.string().min(1).default(DEFAULT_MARKET_CONFIG_DIR),
  SERVICE_AREA_CONFIG_DIR: z.string().min(1).default(DEFAULT_SERVICE_AREA_CONFIG_DIR),
  LOCALE_CONFIG_DIR: z.string().min(1).default(DEFAULT_LOCALE_CONFIG_DIR),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgresql:// connection URL'),
  // Kazem, spike 6 decision 2: an explicit pool maximum per process, 10 unless set.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Identity design 9: the local mail catcher's HTTP base URL (Mailpit's UI/API port).
  MAIL_CATCHER_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL such as http://localhost:8025' })
    .optional(),
  // The directory of the local object store (proof-of-delivery photos, documents). Unset: storing
  // a file answers "unavailable". An S3-compatible adapter replaces it for production.
  OBJECT_STORE_DIR: z.string().min(1).max(500).optional(),
  // ADR-0037: the BFF networks and their keys. Both empty or unset: the feature is off. Parsed
  // and checked by parseClientAddressTrust below; a secret is never echoed.
  TRUSTED_BFF_CIDRS: z.string().optional(),
  CLIENT_ADDRESS_KEYS: z.string().optional(),
  // Redis (route cache, live positions). Unset: each process keeps its own in-memory store.
  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' })
    .optional(),
});

/** The migration role's URL: read by the prisma CLI, the scripts and test setup only. */
export const MIGRATION_DATABASE_URL = 'MIGRATION_DATABASE_URL';

export interface AppConfig {
  /**
   * `api` serves HTTP; `worker` runs the relay and the scheduler (platform persistence 8).
   * Read by `main.ts` only (and `platform/worker/`, P 12.2 rule 3); a module never branches on it.
   */
  readonly appRole: AppRole;
  readonly nodeEnv: 'development' | 'test' | 'production';
  /**
   * True when `NODE_ENV` was set in the environment, false when `nodeEnv` is the default. A
   * development-only stand-in (the local key wrapper) starts only on an explicit value, so a
   * deployment that forgets `NODE_ENV` fails closed (security review of slice 1c, M2).
   */
  readonly nodeEnvExplicit: boolean;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Markets this Region Stack serves (ADR-0003). Never empty, never defaulted. */
  readonly hostedMarkets: readonly MarketId[];
  /** Serve Swagger UI at /docs. Off unless explicitly enabled (fails closed). */
  readonly apiDocsEnabled: boolean;
  /** Directories holding `<CODE>.json` Market configuration (ADR-0003 decision 5). */
  readonly marketConfigDirs: readonly string[];
  /** Directories holding `<MARKET>.json` ServiceArea postcode sets (ADR-0005 decision 7). */
  readonly serviceAreaConfigDirs: readonly string[];
  /**
   * Directories holding `<locale>/<module>.json` translation catalogues (marketplace identity
   * design 9). `LOCALE_CONFIG_DIR`, default `config/locales`.
   */
  readonly localeConfigDirs: readonly string[];
  /** PostgreSQL connection URL. Contains credentials: never log it. */
  readonly databaseUrl: string;
  /**
   * The most pooled connections this process opens (platform persistence design 3.1 row 8).
   * `DATABASE_POOL_MAX`, 1 to 100, default 10.
   */
  readonly databasePoolMax: number;
  /**
   * The local mail catcher's base URL (`MAIL_CATCHER_URL`), or null: then every mail send
   * fails and its delivery is retried and dead-lettered (identity design 9). Set, it is refused
   * unless `NODE_ENV` is explicitly `development` or `test` (`platform/mail/`).
   */
  readonly mailCatcherUrl: string | null;
  /**
   * The directory of the local object store (`OBJECT_STORE_DIR`), resolved to an absolute path,
   * or null: then storing a file fails with "unavailable" (`platform/storage/`).
   */
  readonly objectStoreDir: string | null;
  /**
   * Who may prove a client address, and with which keys (ADR-0037 decisions 4 and 5): from
   * `TRUSTED_BFF_CIDRS` and `CLIENT_ADDRESS_KEYS`. `null` when both are empty: the address is the
   * socket's. Holds secrets, which print as a marker only; read by `configureApp` alone.
   */
  readonly clientAddressTrust: ClientAddressTrust | null;
  /** `REDIS_URL`, or null: then caches stay in the process. May hold a password: never log it. */
  readonly redisUrl: string | null;
}

/** The log levels a worker may run at: every one that still writes info lines. */
const WORKER_LOG_LEVELS: ReadonlySet<string> = new Set(['info', 'debug', 'trace']);

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Validates the process environment once at startup. The application refuses to start
 * on invalid configuration instead of failing later on first use.
 */
export function loadAppConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
  // The application never receives the migration role's URL (docs/design/data/platform.md
  // 10.7): present at all, an empty value included, it refuses to start. The value is never
  // printed.
  if (MIGRATION_DATABASE_URL in env) {
    issues.push(
      `${MIGRATION_DATABASE_URL}: must not be set for the application; it is for ` +
        'pnpm db:*, pnpm test:db and pnpm verify only',
    );
  }
  // The worker writes the audit chain's anchors as info lines (LogAnchorSink, PA 8): a level
  // above info would drop them silently, so the worker refuses one (Hassan, 6b review L1).
  if (
    parsed.success &&
    parsed.data.APP_ROLE === 'worker' &&
    !WORKER_LOG_LEVELS.has(parsed.data.LOG_LEVEL)
  ) {
    issues.push(
      'LOG_LEVEL: the worker logs at info, debug or trace (audit anchors are info lines)',
    );
  }
  const clientAddress = parseClientAddressTrust(env.TRUSTED_BFF_CIDRS, env.CLIENT_ADDRESS_KEYS);
  issues.push(...clientAddress.issues);
  if (!parsed.success || issues.length > 0) {
    throw new InvalidConfigError(issues);
  }
  return Object.freeze({
    appRole: parsed.data.APP_ROLE,
    nodeEnv: parsed.data.NODE_ENV,
    nodeEnvExplicit: env.NODE_ENV !== undefined,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    hostedMarkets: Object.freeze([...parsed.data.HOSTED_MARKETS]),
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED === 'true',
    marketConfigDirs: Object.freeze([path.resolve(parsed.data.MARKET_CONFIG_DIR)]),
    serviceAreaConfigDirs: Object.freeze([path.resolve(parsed.data.SERVICE_AREA_CONFIG_DIR)]),
    localeConfigDirs: Object.freeze([path.resolve(parsed.data.LOCALE_CONFIG_DIR)]),
    databaseUrl: parsed.data.DATABASE_URL,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    mailCatcherUrl: parsed.data.MAIL_CATCHER_URL ?? null,
    objectStoreDir:
      parsed.data.OBJECT_STORE_DIR === undefined
        ? null
        : path.resolve(parsed.data.OBJECT_STORE_DIR),
    clientAddressTrust: clientAddress.trust,
    redisUrl: parsed.data.REDIS_URL ?? null,
  });
}
