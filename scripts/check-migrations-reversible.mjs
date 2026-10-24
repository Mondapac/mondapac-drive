// Proves every migration is reversible (ADR-0004 decision 6): on a fresh, throwaway
// database apply all migrations (up), run every down.sql newest-first (down), check that
// nothing is left behind, apply all migrations again (up), and finally check that the
// migrated database matches prisma/schema (no drift).
//
// It connects as the migration role (MIGRATION_DATABASE_URL, never DATABASE_URL), which
// owns and creates the throwaway database (docs/design/data/platform.md 10.4, 10.7).
//
// Usage: MIGRATION_DATABASE_URL=postgresql://... node scripts/check-migrations-reversible.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('apps/api/package.json'));
const { Client } = require('pg');

try {
  process.loadEnvFile();
} catch {
  // No .env file: MIGRATION_DATABASE_URL must come from the environment.
}

const baseUrl = process.env.MIGRATION_DATABASE_URL;
if (!baseUrl) {
  console.error('MIGRATION_DATABASE_URL (the migration role) is required; see .env.example.');
  process.exit(1);
}

const migrationsDir = path.resolve('prisma/migrations');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const missingDown = migrations.filter(
  (name) => !existsSync(path.join(migrationsDir, name, 'down.sql')),
);
if (missingDown.length > 0) {
  console.error(`Migrations without down.sql: ${missingDown.join(', ')}`);
  process.exit(1);
}

const scratchName = `migration_check_${randomBytes(6).toString('hex')}`;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${scratchName}`;

function migrateDeploy() {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: scratchUrl.toString() },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
}

const admin = new Client({ connectionString: baseUrl });
await admin.connect();
let failed = false;
try {
  await admin.query(`CREATE DATABASE "${scratchName}"`);
  // A new database gets the default ACL, not its template's: the same two statements as
  // every application database (10.7).
  await admin.query(`REVOKE ALL ON DATABASE "${scratchName}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${scratchName}" TO "drive_app"`);

  console.log(`up:   ${migrations.length} migration(s)`);
  migrateDeploy();

  const scratch = new Client({ connectionString: scratchUrl.toString() });
  await scratch.connect();
  try {
    for (const name of [...migrations].reverse()) {
      console.log(`down: ${name}`);
      await scratch.query(readFileSync(path.join(migrationsDir, name, 'down.sql'), 'utf8'));
    }

    // After all downs only empty schemas without grants, Prisma's own bookkeeping table and the
    // members of extensions the cluster bootstrap installed (PostGIS) may remain. Table grants vanish with their tables; a schema grant survives a missing
    // REVOKE (10.5 guard 2).
    const leftovers = await scratch.query(`
      SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND c.relname <> '_prisma_migrations' AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
         AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                            AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT n.nspname || '.' || p.proname || '()'
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                            AND d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT n.nspname || '.' || t.typname || ' (type)'
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND t.typtype IN ('e', 'd')
         AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                            AND d.objid = t.oid AND d.deptype = 'e')
      UNION ALL
      SELECT n.nspname || ' (schema privilege ' || a.privilege_type || ' held by '
             || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ')'
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
         AND a.grantee <> n.nspowner
    `);
    if (leftovers.rowCount > 0) {
      throw new Error(
        `down.sql left objects behind: ${leftovers.rows.map((row) => row.name).join(', ')}`,
      );
    }

    await scratch.query('DELETE FROM "_prisma_migrations"');
  } finally {
    await scratch.end();
  }

  console.log(`up:   ${migrations.length} migration(s) again`);
  migrateDeploy();
  // The migrated database must match prisma/schema exactly (no drift).
  try {
    execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema',
        '--exit-code',
      ],
      {
        env: { ...process.env, MIGRATION_DATABASE_URL: scratchUrl.toString() },
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: process.platform === 'win32',
      },
    );
  } catch {
    throw new Error(
      'The migrated database differs from prisma/schema: a schema change has no migration, ' +
        'or a migration was edited by hand in a way the schema does not describe.',
    );
  }

  console.log('Migrations are reversible and match the schema.');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
