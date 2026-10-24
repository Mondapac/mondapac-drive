import { Client } from 'pg';
import { EXPECTED_PRIVILEGES } from './expected-privileges';
import { testDatabaseUrl } from './test-database';

// docs/design/data/platform.md 10.5 guard 1. Neither `pnpm db:check-reversible` nor Prisma's
// drift check sees privileges, so this compares the catalogs of the migrated database with a
// checked-in map. It reads them with `aclexplode`, which every role may run, unlike
// `information_schema`, which hides what the connected role holds no privilege on.

const APPLICATION_GROUP_ROLE = 'drive_app';

/** Schemas that are not PostgreSQL's own; `n` is `pg_namespace`. */
const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/** The extensions the cluster bootstrap installs, as an SQL list. */
const CLUSTER_EXTENSIONS = Object.keys(EXPECTED_PRIVILEGES.clusterExtensions)
  .map((name) => `'${name}'`)
  .join(', ');

/** True for a member of a cluster extension; `catalog` is its pg_* table, `oid` its row. */
const notClusterExtensionMember = (catalog: string, oid: string) => `NOT EXISTS (
  SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
   WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e'
     AND d.refclassid = 'pg_extension'::regclass AND e.extname IN (${CLUSTER_EXTENSIONS}))`;

const GRANTEE = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END`;

interface Grant {
  readonly object: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
}

const SCHEMA_GRANTS = `
SELECT n.nspname AS object, ${GRANTEE} AS grantee, a.privilege_type AS privilege,
       a.is_grantable AS grantable
  FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
 WHERE ${USER_SCHEMA} AND a.grantee <> n.nspowner
   -- PostgreSQL's own grant on the public schema.
   AND NOT (n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'USAGE')`;

const RELATION_GRANTS = `
SELECT n.nspname || '.' || c.relname AS object, ${GRANTEE} AS grantee,
       a.privilege_type AS privilege, a.is_grantable AS grantable
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND a.grantee <> c.relowner
   AND ${notClusterExtensionMember('pg_class', 'c.oid')}`;

const COLUMN_GRANTS = `
SELECT n.nspname || '.' || c.relname || '.' || att.attname AS object, ${GRANTEE} AS grantee,
       a.privilege_type AS privilege, a.is_grantable AS grantable
  FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN LATERAL aclexplode(att.attacl) a
 WHERE ${USER_SCHEMA} AND NOT att.attisdropped AND a.grantee <> c.relowner
   AND ${notClusterExtensionMember('pg_class', 'c.oid')}`;

const TABLES = `
SELECT n.nspname || '.' || c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p')
   AND ${notClusterExtensionMember('pg_class', 'c.oid')}
 ORDER BY 1`;

/** A function's default ACL, when it has none, lets PUBLIC execute it. */
const FUNCTIONS = `
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         AS name,
       p.prorettype = 'trigger'::regtype AS is_trigger, p.prosecdef AS security_definer,
       n.nspname AS schema,
       (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
           AND d.refclassid = 'pg_extension'::regclass) AS extension,
       coalesce(EXISTS (SELECT 1 FROM unnest(p.proconfig) setting
                         WHERE setting LIKE 'search\\_path=%'), false) AS sets_search_path,
       coalesce((SELECT array_agg(${GRANTEE} ORDER BY 1)
                   FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee <> p.proowner), '{}'::text[]) AS grantees
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE ${USER_SCHEMA} AND ${notClusterExtensionMember('pg_proc', 'p.oid')}
 ORDER BY 1`;

describe('privileges of the migrated database (docs/design/data/platform.md 10.5)', () => {
  let sql: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function grants(query: string): Promise<Grant[]> {
    return (await sql.query<Grant>(query)).rows;
  }

  function byObject(rows: readonly Grant[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const row of rows) (result[row.object] ??= []).push(row.privilege);
    for (const privileges of Object.values(result)) privileges.sort();
    return result;
  }

  it('grants nothing to a role other than the application group, and no grant option', async () => {
    const rows = [
      ...(await grants(SCHEMA_GRANTS)),
      ...(await grants(RELATION_GRANTS)),
      ...(await grants(COLUMN_GRANTS)),
    ];

    expect(rows.filter((row) => row.grantee !== APPLICATION_GROUP_ROLE || row.grantable)).toEqual(
      [],
    );
  });

  it('grants the schema privileges of the map, and no other', async () => {
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_PRIVILEGES.schemas)
        .filter(([, privileges]) => privileges.length > 0)
        .map(([schema, privileges]) => [schema, [...privileges].sort()]),
    );

    expect(byObject(await grants(SCHEMA_GRANTS))).toEqual(expected);
  });

  it('has a map entry for every table, and no entry for a table that does not exist', async () => {
    const tables = (await sql.query<{ name: string }>(TABLES)).rows.map((row) => row.name);

    expect(tables).toEqual(Object.keys(EXPECTED_PRIVILEGES.tables).sort());
  });

  it('grants the table privileges of the map, and no other', async () => {
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_PRIVILEGES.tables)
        .filter(([, entry]) => entry.table.length > 0)
        .map(([table, entry]) => [table, [...entry.table].sort()]),
    );

    expect(byObject(await grants(RELATION_GRANTS))).toEqual(expected);
  });

  it('grants column-level UPDATE only, as the map lists it, and never beside table-level UPDATE', async () => {
    const expected: Record<string, string[]> = {};
    for (const [table, entry] of Object.entries(EXPECTED_PRIVILEGES.tables)) {
      expect(entry.columnUpdate.length > 0 && entry.table.includes('UPDATE')).toBe(false);
      for (const column of entry.columnUpdate) expected[`${table}.${column}`] = ['UPDATE'];
    }

    expect(byObject(await grants(COLUMN_GRANTS))).toEqual(expected);
  });

  it('has no default privileges and no parameter grants', async () => {
    const defaults = await sql.query('SELECT defaclrole, defaclnamespace FROM pg_default_acl');
    const parameters = await sql.query('SELECT parname FROM pg_parameter_acl');

    expect(defaults.rows).toEqual([]);
    expect(parameters.rows).toEqual([]);
  });

  it('lets PUBLIC execute trigger functions only, and lists every SECURITY DEFINER function', async () => {
    const functions = (
      await sql.query<{
        name: string;
        is_trigger: boolean;
        security_definer: boolean;
        sets_search_path: boolean;
        grantees: string[];
        schema: string;
        extension: string | null;
      }>(FUNCTIONS)
    ).rows;

    // A member function of a mapped extension in its mapped, closed schema is the one exception
    // to "PUBLIC executes triggers only" (10.5 guard 1; the closed-schema tests are below).
    const mappedExtensionMember = (fn: { extension: string | null; schema: string }): boolean =>
      fn.extension !== null &&
      fn.schema !== 'public' &&
      EXPECTED_PRIVILEGES.extensions[fn.extension] === fn.schema;
    const wrongGrantees = functions.filter(
      (fn) =>
        fn.grantees.some((grantee) => grantee !== 'PUBLIC' && grantee !== APPLICATION_GROUP_ROLE) ||
        (!fn.is_trigger && fn.grantees.includes('PUBLIC') && !mappedExtensionMember(fn)),
    );
    const definers = functions.filter((fn) => fn.security_definer);

    expect(wrongGrantees).toEqual([]);
    expect(definers.map((fn) => fn.name)).toEqual(
      Object.keys(EXPECTED_PRIVILEGES.securityDefinerFunctions).sort(),
    );
    expect(definers.filter((fn) => !fn.sets_search_path)).toEqual([]);
  });

  it('installs exactly the extensions of the map and of the cluster bootstrap, each in its mapped schema', async () => {
    const installed = await sql.query<{ extname: string; schema: string }>(
      `SELECT e.extname, n.nspname AS schema FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql' ORDER BY 1`,
    );

    expect(Object.fromEntries(installed.rows.map((row) => [row.extname, row.schema]))).toEqual({
      ...EXPECTED_PRIVILEGES.extensions,
      ...EXPECTED_PRIVILEGES.clusterExtensions,
    });
  });

  it('keeps every extension schema closed: no USAGE for the application, CREATE for the owner only, on no search_path', async () => {
    for (const schema of new Set(Object.values(EXPECTED_PRIVILEGES.extensions))) {
      expect(schema).not.toBe('public');
      const usage = await sql.query<{ usage: boolean }>(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage`,
        [APPLICATION_GROUP_ROLE, schema],
      );
      const holders = await sql.query(
        `SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
          WHERE n.nspname = $1 AND a.grantee <> n.nspowner`,
        [schema],
      );
      // The application group, the roles it is a member of, the roles that are members of it (the
      // login roles) and the database: a setting that names the schema puts it on a search_path.
      const settings = await sql.query<{ setting: string }>(
        `SELECT unnest(s.setconfig) AS setting
           FROM pg_db_role_setting s
          WHERE (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
            AND (s.setrole = 0
                 OR pg_has_role($1, s.setrole, 'MEMBER')
                 OR pg_has_role(s.setrole, $1::name, 'MEMBER'))`,
        [APPLICATION_GROUP_ROLE],
      );

      expect(usage.rows[0]?.usage).toBe(false);
      expect(holders.rows).toEqual([]);
      expect(
        settings.rows.filter(
          (row) => row.setting.startsWith('search_path=') && row.setting.includes(schema),
        ),
      ).toEqual([]);
    }
  });
});
