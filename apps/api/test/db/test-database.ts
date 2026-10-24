import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * A variable from the environment or, for local development, from the repository's `.env`.
 * The tests read the two database URLs here only; the application under test gets its
 * configuration from an explicit object (docs/design/data/platform.md 10.7, AppConfig).
 */
function fromEnvironment(name: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL', role: string): string {
  const envFile = path.join(REPO_ROOT, '.env');
  if (!process.env[name] && existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} (${role}) is required for database tests. Start the services with ` +
        '`docker compose up -d` and copy .env.example to .env.',
    );
  }
  return url;
}

/** The migration role's URL: it creates, migrates and drops the throwaway database. */
export function migrationDatabaseUrl(): string {
  return fromEnvironment('MIGRATION_DATABASE_URL', 'the migration role');
}

/** The application login's URL; setup keeps its credentials and swaps the database name. */
export function applicationDatabaseUrl(): string {
  return fromEnvironment('DATABASE_URL', 'the application login');
}

function exported(
  name:
    | 'TEST_DATABASE_URL'
    | 'TEST_OWNER_DATABASE_URL'
    | 'TEST_LOCKING_DATABASE_URL'
    | 'TEST_LOCKING_OWNER_DATABASE_URL'
    | 'TEST_RELAY_DATABASE_URL'
    | 'TEST_DELIVERY_DATABASE_URL'
    | 'TEST_AUDIT_DATABASE_URL'
    | 'TEST_AUDIT_OWNER_DATABASE_URL',
): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(`${name} is not set: database tests must run via jest.db.config.cjs`);
  }
  return url;
}

/** The throwaway database of this run, as the application login (`drive_app`). */
export function testDatabaseUrl(): string {
  return exported('TEST_DATABASE_URL');
}

/** The throwaway database of this run, as its owner (the migration role). */
export function ownerTestDatabaseUrl(): string {
  return exported('TEST_OWNER_DATABASE_URL');
}

/**
 * The copy of the run database that unit-of-work.db-spec.ts locks and adds test-only
 * triggers to (global-setup.ts), as the application login and as its owner.
 */
export function lockingTestDatabaseUrl(): string {
  return exported('TEST_LOCKING_DATABASE_URL');
}

export function lockingOwnerTestDatabaseUrl(): string {
  return exported('TEST_LOCKING_OWNER_DATABASE_URL');
}

/**
 * The copy of the run database that relay.db-spec.ts relays and starts a worker on
 * (global-setup.ts), as the application login: no other file's outbox rows live there.
 */
export function relayTestDatabaseUrl(): string {
  return exported('TEST_RELAY_DATABASE_URL');
}

/**
 * The copy of the run database that event-delivery.db-spec.ts relays and dispatches on
 * (global-setup.ts), as the application login: no other file's outbox or delivery rows live there.
 */
export function deliveryTestDatabaseUrl(): string {
  return exported('TEST_DELIVERY_DATABASE_URL');
}

/**
 * The copy that platform-audit-chain.db-spec.ts seals, tampers with and resets, as the
 * application login and as its owner (the owner tampers and resets with the triggers off).
 */
export function auditTestDatabaseUrl(): string {
  return exported('TEST_AUDIT_DATABASE_URL');
}

export function auditOwnerTestDatabaseUrl(): string {
  return exported('TEST_AUDIT_OWNER_DATABASE_URL');
}

export { REPO_ROOT };
