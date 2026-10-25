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
    identity: ['USAGE'],
    dispatch: ['USAGE'],
    notifications: ['USAGE'],
    payouts: ['USAGE'],
    platform: ['USAGE'],
    tracking: ['USAGE'],
    fleet: ['USAGE'],
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
    // and the outbox envelope are append-only (20261024150000, 20261024160000); the exception
    // flag and the wrong-PIN count are set outside the version (20261026010000, 20261026011000).
    'delivery.deliveries': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['courier_id', 'exception', 'status', 'version', 'wrong_pins'],
    },
    // Proof photos are append-only (20261026011000).
    'delivery.proof_photos': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'delivery.delivery_events': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'delivery.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'delivery.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // The identity module (20261024170000, copied from the marketplace's identity migrations):
    // no account is deleted by the application, the outbox envelope and the inbox are
    // append-only, a merchant and a membership change only their state.
    'identity.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'identity.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // 20261025121200 (Hassan, WP2 review): UPDATE only of the columns the application writes.
    'identity.accounts': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'display_name',
        'timezone',
        'locale',
        'status',
        'email_verified_at',
        'signed_up_at',
        'version',
      ],
    },
    'identity.password_credentials': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.sessions': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['last_seen_at', 'revoked_at', 'revoked_reason', 'token_hash'],
    },
    'identity.sign_in_throttles': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.sign_in_records': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.one_time_links': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.merchants': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['state', 'state_changed_at', 'version'],
    },
    'identity.merchant_memberships': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['removed_at', 'state', 'version'],
    },
    'identity.roles': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.role_permissions': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.role_assignments': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.second_factors': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.recovery_codes': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.sign_in_challenges': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.invitations': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // The dispatch module: a job keeps its delivery and requirements, an offer only gets its
    // answer; the outbox envelope is append-only (20261025070000). The offer's stops, the
    // followed delivery version and an early opening change too (20261026020000); the stops are
    // suburbs and postcodes, not addresses (20261027020000).
    'dispatch.jobs': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'assigned_at',
        'assigned_courier_id',
        'assigned_vehicle',
        'assignment_method',
        'delivery_version',
        'dropoff_lat',
        'dropoff_lng',
        'dropoff_postcode',
        'dropoff_suburb',
        'excluded_courier_ids',
        'next_action_at',
        'opens_at',
        'pickup_postcode',
        'pickup_suburb',
        'round',
        'status',
        'trip_distance_metres',
        'version',
      ],
    },
    'dispatch.offers': { table: ['INSERT', 'SELECT'], columnUpdate: ['answered_at', 'status'] },
    'dispatch.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'dispatch.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // The tracking module (20261025060000): only the status, courier and end of a tracked
    // delivery change; breadcrumbs and links are never edited. DELETE is the retention job's.
    'tracking.tracked_deliveries': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [
        'courier_id',
        'delivery_version',
        'ended_at',
        'status',
        'updated_at',
        'vehicle',
        'version',
      ],
    },
    // 20261026060000: tracking's inbox for the delivery lifecycle subscribers, append-only.
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'tracking.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'tracking.breadcrumbs': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'tracking.links': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // The notifications module (20261025110000): only the retry state of a queued message and
    // the status, event types, secret version and rotation overlap of a subscription change
    // (20261026050000); the inbox is append-only.
    'notifications.webhook_subscriptions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'event_types',
        'previous_secret_valid_until',
        'secret_version',
        'status',
        'version',
      ],
    },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'notifications.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'notifications.webhook_calls': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'dead_at',
        'last_error_code',
        'last_status_code',
        'next_attempt_at',
        'sent_at',
        'status',
      ],
    },
    'notifications.sms_messages': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'dead_at',
        'last_error_code',
        'next_attempt_at',
        'provider_message_id',
        'sent_at',
        'status',
      ],
    },
    // The fleet module (20261025050000): no row is deleted; a courier changes its standing, shift
    // and the terms an operator confirms, a vehicle its active flag, a document its review and
    // the expiry the operator confirmed; the outbox envelope is immutable. 20261026030000: a
    // courier's idle time and tax registration, and a vehicle's capacity an operator overrides.
    'fleet.couriers': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'cold_chain_capable',
        'employment_type',
        'idle_since',
        'shift',
        'status',
        'tax_registered',
        'version',
      ],
    },
    'fleet.vehicles': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['active', 'max_volume_litres', 'max_weight_grams'],
    },
    'fleet.documents': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['expires_at', 'rejection_reason', 'reviewed_at', 'status'],
    },
    'fleet.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // 20261027010000: the jobs fleet follows from delivery's events (a job changes its courier,
    // its end and the applied version, and is never deleted), and fleet's append-only inbox.
    'fleet.courier_jobs': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['assigned_at', 'courier_account_id', 'delivery_version', 'ended'],
    },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'fleet.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // The payouts module (20261025100000): the ledger, delivery records, runs and handled
    // provider events are append-only; a line changes only its transfer state, an account only
    // whether it can be paid out.
    'payouts.ledger_entries': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'payouts.courier_deliveries': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'payouts.payout_runs': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'payouts.payout_lines': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'hold_reason',
        'last_error_code',
        'reversed_amount',
        'status',
        'transfer_id',
        'updated_at',
        'version',
      ],
    },
    'payouts.payout_accounts': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['payouts_enabled', 'provider_state_at', 'updated_at'],
    },
    'payouts.provider_events': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // 20261026040000 (handoff 24): the payouts outbox and inbox, as every module's.
    'payouts.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // 20261027050000 (handoff 35): DELETE for platform.inbox-retention.
    'payouts.inbox': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
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
