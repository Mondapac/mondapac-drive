/**
 * Every privilege a migration grants, checked in (docs/design/data/platform.md 10.2 and 10.5
 * guard 1). `privileges.db-spec.ts` compares the catalogs of the migrated database with this
 * map; a migration that grants, revokes or adds a table changes this file in the same PR.
 * The only grantee is the group role `drive_app`; the owner's own privileges are not listed.
 */
export interface ExpectedPrivileges {
  /** Schema-level privileges of `drive_app`, by schema. */
  readonly schemas: Readonly<Record<string, readonly string[]>>;
  /**
   * Every table of every schema that is not PostgreSQL's own, with the table-level privileges
   * of `drive_app` and the columns it may UPDATE when it has no table-level UPDATE.
   */
  readonly tables: Readonly<
    Record<string, { readonly table: readonly string[]; readonly columnUpdate: readonly string[] }>
  >;
  /**
   * Extensions the migrations install, each with its schema. A member function of a mapped
   * extension may be executable by PUBLIC (its owner is a superuser, so the migration role
   * cannot revoke that) only while the schema stays closed to the application: no `USAGE`, no
   * `CREATE` for anyone but its owner, and on nobody's `search_path` (platform.md 10.5 guard 1,
   * docs/design/data/sellers.md 9.2 and 9.6). Never `public`.
   */
  readonly extensions: Readonly<Record<string, string>>;
  /**
   * Extensions the cluster bootstrap installs as a superuser (scripts/db/bootstrap-dev.sql, and
   * the platform team's provisioning in a deployed Region Stack), each with its schema. PostGIS is
   * not a trusted extension, so no migration can create it. Its member objects keep the grants
   * PostGIS gives PUBLIC and are left out of every other check here; the migrations grant nothing
   * on them.
   */
  readonly clusterExtensions: Readonly<Record<string, string>>;
  /** Every SECURITY DEFINER function (`schema.name(arguments)`), with why it is one. */
  readonly securityDefinerFunctions: Readonly<Record<string, string>>;
}

export const EXPECTED_PRIVILEGES: ExpectedPrivileges = {
  schemas: {
    // No privilege for the application on `extensions` (see `extensions` below).
    extensions: [],
    delivery: ['USAGE'],
    platform: ['USAGE'],
  },
  tables: {
    'platform.audit_log': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/platform.md 11.6 (identity slice 6a): append-only like the audit log;
    // INSERT moves to a worker-only group before the hardening trigger (11.6, PA 13).
    'platform.audit_log_seal': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'platform.audit_chain_checkpoint': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Buyer assistant package 1 (identity design 13): the shared rate-limit counters, counted
    // and purged by the PostgreSQL store of rate-limiter-flexible.
    'platform.rate_limit_counters': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 3; PM3): the envelope copy is immutable to
    // the application; DELETE arrives with the prune job.
    'platform.event_delivery': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'dead_at',
        'delivered_at',
        'error_code',
        'next_attempt_at',
        'status',
      ],
    },
    // docs/design/data/identity.md section 7 (PF 4): a tombstone, no DELETE; the identity
    // columns are frozen by the trigger as well.
    'platform.subject_keys': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['wrapped_key', 'wrapping_key_id', 'rewrapped_at', 'destroyed_at'],
    },
    // The delivery module: deliveries keep their identity, market and money columns; history
    // and the outbox envelope are append-only (20261024150000, 20261024160000).
    'delivery.deliveries': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['courier_id', 'status', 'version'],
    },
    'delivery.delivery_events': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'delivery.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'delivery.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Prisma's own bookkeeping, owned by the migration role; nothing for the application.
    'public._prisma_migrations': { table: [], columnUpdate: [] },
  },
  extensions: {
    // Exclusion constraints on `=` of ids (sellers tax registration periods; V2 records later).
    btree_gist: 'extensions',
  },
  clusterExtensions: {
    // The geography columns and GiST indexes of delivery (20261024130000, 20261024150000).
    postgis: 'public',
  },
  securityDefinerFunctions: {},
};
