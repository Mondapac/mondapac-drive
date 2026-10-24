import { Client } from 'pg';
import { migrationDatabaseUrl } from './test-database';

export default async function globalTeardown(): Promise<void> {
  const names = [
    process.env.TEST_LOCKING_DATABASE_NAME,
    process.env.TEST_RELAY_DATABASE_NAME,
    process.env.TEST_DELIVERY_DATABASE_NAME,
    process.env.TEST_AUDIT_DATABASE_NAME,
    process.env.TEST_DATABASE_NAME,
  ].filter((name): name is string => name !== undefined && name !== '');
  if (names.length === 0) return;

  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    for (const name of names) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
