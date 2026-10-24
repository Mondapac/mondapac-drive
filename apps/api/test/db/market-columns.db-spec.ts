import { Client } from 'pg';
import { testDatabaseUrl } from './test-database';

// Platform-foundations design section 9 and docs/design/data/platform.md 10.4: every table
// with `market_id` also has `tenant_id`, both NOT NULL and with no default (no database or
// Prisma default: the application supplies both from a minted MarketContext). It reads
// `pg_catalog`, not `information_schema`, which hides tables the connected role holds no
// privilege on, so the test passes or fails the same way under any role.

const TABLES_WITH_MARKET_ID = `
SELECT n.nspname || '.' || c.relname AS table_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'market_id' AND NOT a.attisdropped)
 ORDER BY 1`;

const OFFENDING_TABLES = `
SELECT n.nspname || '.' || c.relname AS offending_table
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'market_id' AND NOT a.attisdropped)
   AND 2 <> (SELECT count(*) FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname IN ('market_id', 'tenant_id')
                AND NOT a.attisdropped AND a.attnotnull AND NOT a.atthasdef
                AND a.attidentity = '' AND a.attgenerated = '')
 ORDER BY 1`;

describe('market and tenant columns (database catalog)', () => {
  let sql: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  it('sees the real tables: platform.audit_log carries market_id', async () => {
    const { rows } = await sql.query<{ table_name: string }>(TABLES_WITH_MARKET_ID);

    expect(rows.map((row) => row.table_name)).toContain('platform.audit_log');
  });

  it('finds no table whose market_id or tenant_id is nullable, defaulted or missing', async () => {
    const { rows } = await sql.query<{ offending_table: string }>(OFFENDING_TABLES);

    expect(rows.map((row) => row.offending_table)).toEqual([]);
  });
});
