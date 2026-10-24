# platform/persistence

Implements platform persistence design sections 3 to 9 and 12.3
(docs/design/domain/platform-persistence-and-events.md) and ADR-0025: identity slices 1a
(UnitOfWork, guard, model map) and 1b (outbox, relay, scheduler lock, `APP_ROLE`).

## What a module uses

- `UNIT_OF_WORK` (`platform/unit-of-work/unit-of-work.ts`): `run(market, work, options)`.
  - A read-write unit is one interactive transaction at READ COMMITTED, or SERIALIZABLE
    when asked.
  - An `err` result rolls back.
  - `40001` and `40P01` are retried, 3 attempts in all.
  - `55P03` becomes `TransactionConflictError` at once.
  - The HTTP filter answers 409 `conflict.retry` or `conflict.stale`.
  - A unit that is already open cannot open another (`NestedUnitOfWorkError`).
- `PrismaService.tx(market)` returns the open unit's `MarketTransaction`.
  - It is a frozen view of the model delegates only: no `$transaction` and no raw SQL.
  - It is refused outside a unit, and refused for another Market.
  - It has no audit models: see "Audit writer" below.
- Only `prisma.service.ts` may be imported from `modules/*/infrastructure`
  (dependency-cruiser rule `persistence-root-is-private`).
- A module touches only the models of its own `prisma/schema/<module>.prisma`. The check is
  `pnpm boundaries`.

## Read-only units (ADR-0025)

- `{ readOnly: true }` opens no transaction.
- `work` runs once on the guarded base client and is never retried.
- Writes are refused.
- Any query after the unit closes is refused (`unit-closed`).
- Isolation and timeout options are refused for read-only units.
- At start-up the API refuses to listen unless `default_transaction_isolation` is
  `read committed` (`databaseIsolationAccepted` in `check-database-role.ts`).

## Named raw statements and `lockTimeoutMs` (inventory slice 2, part 2; P 4.2)

- Raw SQL stays refused for modules. The one exception is a closed list in
  `named-statements.ts`, reached through `PrismaService.namedQuery(market, name, params)`:
  - `inventory.lock-stock-items` locks stock items `FOR NO KEY UPDATE` in ascending id order
    (inventory data design 4.3). One to 1,000 distinct ids; fewer rows back than ids is
    `NamedStatementRefusedError('rows-missing')`.
  - The Market and tenant are bound from the open unit, never from `params`; every other value
    is a bound parameter. The text is fixed.
  - It needs an open read-write unit of the same Market; a read-only unit gets
    `NamedStatementRefusedError('read-only-unit')`.
- The market guard lets a raw operation through only for the exact text of a listed statement,
  through `$queryRaw` or `$executeRaw`, with the open unit's Market and tenant as its
  parameters, in an open read-write unit. Recognition is by text because Prisma copies the
  `Sql` object before the extension sees it. Every `Unsafe` form stays refused.
- A statement named `<module>.<name>` may be called only from `modules/<module>/`
  (`named-statement-owners.spec.ts`).
- `UnitOfWorkOptions.lockTimeoutMs` (1 to 3000, read-write units only) issues
  `SET LOCAL lock_timeout` as the first statement of every attempt. A wait that runs out ends
  the unit with `TransactionConflictError('55P03')`. It is never above 3 s, the
  ceiling the start-up check `role_timeouts` enforces on the login role; a role set lower can
  be raised, up to that ceiling, by a unit that asks for it.
- A new statement is a change to `named-statements.ts` with its guard rule, a two-Market
  database test, and reviews by the database-designer and the security-tester.

## Market guard

`market-guard.ts` is a Prisma client extension. It refuses any query that:

- runs with no open unit, or after the unit has closed;
- is raw SQL;
- has a `where`, selector or data that does not pin the unit's `marketId` and `tenantId`;
- is an upsert by id, or an upsert without a compound selector that contains `marketId`;
- is a nested write.

Models marked `/// @market-scope none: <reason>` are exempt.

The guard reads the model map: `apps/api/src/generated/model-map.ts`.

- It is written by `scripts/generate-model-map.mjs`, which runs as a Prisma generator on
  every `prisma generate`.
- It is checked against Prisma's DMMF.

## Start-up checks

`main.ts` refuses to listen when `DatabaseProbe.roleProblems()` returns any problem
(docs/design/data/platform.md 10.8). One of its reasons is `role_timeouts`: the login role's
own settings (`pg_roles.rolconfig`) must hold `statement_timeout` (at most 30 s),
`lock_timeout` (at most 3 s) and `idle_in_transaction_session_timeout` (at most 60 s), each
above zero. `scripts/db/bootstrap-dev.sql` sets them. A Compose volume created before that
change does not have them, and the API will not start on it until you run
`pnpm db:bootstrap` once.

## Configuration

- `DATABASE_POOL_MAX`: pool size. Integer from 1 to 100, default 10.
- The wait for a connection is fixed at 2 s (`connectionTimeoutMillis`).

## Logging

`reduceDatabaseError` reduces a database error to `{name, prismaCode, sqlState, constraint}`.
Rows, values and SQL are never logged.

## Events (slice 1b; P 5 and 6)

- Declare an event with `defineEvent` (kernel) in `modules/<m>/domain/events/`, re-export
  it from `contracts/`, and register it in the module's Nest module:
  `providers: [outboxWriterFor('<m>'), registerEvents('<m>', EVENTS)]`.
  - Payload fields come from `eventField` only: `id`, `enumOf`, `boolean`, `integer`,
    `instant`, `permissionKey`, `listOf`, `optional`. No kind takes free text.
  - `permissionKey` values are refused until the permission registry exists (slice 8a).
- A use case appends inside its read-write unit, after saving the aggregate:
  `await outbox.append(context, aggregate.pendingEvents)` (token `OUTBOX_WRITER`).
  - The writer stamps the event id, Market, tenant and correlation id.
  - It refuses (and so rolls the unit back) when no unit is open, in a read-only unit, for
    another Market, another module's type, a type not in the catalogue, a bad version, or a
    payload that does not match its definition.
- `outbox/` holds the writer, the relay and the in-process bus. It is the only folder that
  may name an outbox model (`pnpm boundaries`).
- The relay runs in the `worker` role only: per module outbox and hosted Market, it claims
  50 rows with `FOR UPDATE SKIP LOCKED`, publishes them to the `EventBus`, marks them, and
  commits. At least once, no order. Slice 1b has no subscriber; delivery comes in slice 3.
- `apps/api/test/contracts/event-catalogue.snapshot.json` lists every event type and its
  fields. A new type or a changed field list fails the contracts test until the snapshot
  changes (a changed list means: publish a new version).

## Scheduler and worker (slice 1b; P 7 and 8)

- A job is a `JobDefinition` in `modules/<m>/presentation/jobs/`, registered with
  `registerJobs('<m>', [job])`. It runs once per hosted Market with that Market's context
  and a new correlation id; it must be safe to run twice and at once.
- `AdvisoryJobLock` holds `pg_try_advisory_xact_lock` in its own transaction for the whole
  run, with `SET LOCAL idle_in_transaction_session_timeout = 0` (the login role's 60 s limit
  would end it otherwise).
- `APP_ROLE` (`api` or `worker`) is required, with no default. `main.ts` reads it and calls
  `startApi` or `startWorker`; both build the same module graph. The worker has no HTTP
  listener; SIGTERM stops the relay and the scheduler (up to 10 s), then closes the graph.

## Audit writer (identity slice 6a; docs/design/domain/platform-audit.md 3, 13)

- Declare an audited action with `defineAuditAction` (kernel) in `modules/<m>/domain/`,
  re-export it from `contracts/`, and register it in the module's Nest module:
  `providers: [registerAuditActions('<m>', ACTIONS), PersistenceModule.auditWriterFor('<m>')]`.
  - `before` and `after` fields come from `auditField` only: the event vocabulary, with a
    required maximum on `listOf`. No kind takes free text.
  - An action open to `anonymous` must declare `after.boundSubjectId` of kind `id` (W4a).
  - A platform component registers under `platform.<component>`.
  - `apps/api/test/contracts/audit-action-catalogue.snapshot.json` lists every action. A new
    or changed action fails the contracts test until the snapshot changes, for security review.
- A use case records inside its read-write unit (token `AUDIT_WRITER`):
  `await audit.record(context, ACTION.entry(id, { before, after }))`.
  - The writer stamps the id, Market, tenant, correlation id and `occurred_at` (from `Clock`,
    in whole milliseconds). It derives the actor from the context: `USER`, `SYSTEM` or
    `ANONYMOUS`.
  - It throws `AuditWriteRefusedError` (a code and a field name, never a value), so the unit
    rolls back. It refuses when no unit is open, the unit is read-only or of another Market,
    the action is not the owner's or not in the sealed catalogue, the actor kind is not
    allowed, a side does not match its fields, a list is too long, a side is over 4 KB of
    canonical JSON, or an anonymous row has no `boundSubjectId`.
  - `permissionKey` values are refused until the permission registry exists (slice 8a-1).
- `audit/` holds the writer; no module imports it (`pnpm boundaries`). From slice 6b only
  identity binds a writer. The contracts test fails when another module binds one, and when
  an action's owner is not the module folder that registers it (`platform.<component>` only
  from `src/platform/<component>/`), for `registerAuditActions` and `auditWriterFor` alike
  (Hassan L4). A new binder changes that test in the PR that needs it, for security review.
- The audit models (`auditLog`, `auditLogSeal`, `auditChainCheckpoint`) are not in the view
  `PrismaService.tx(market)` returns. The writer reaches them through `auditTx(market)`,
  which has the same checks as `tx`. `pnpm boundaries` reserves them to `audit/`, and also
  refuses a destructured model name or a computed key on a `tx(...)` result.
- Migration `platform_audit_seal` (docs/design/data/platform.md 11) adds:
  - `ANONYMOUS` actors, whole milliseconds on `occurred_at`, and an 8 192-byte text cap on
    `before` and `after`;
  - the append-only tables `audit_log_seal` and `audit_chain_checkpoint` (application:
    `SELECT`, `INSERT`).
  - A plain `TRUNCATE platform.audit_log` now fails with `0A000`, because the seal references
    it; with `CASCADE` the triggers refuse it (`23001`).

## Audit chain (identity slice 6b; docs/design/domain/platform-audit.md 6 to 9, ADR-0032)

- `platform/audit/` holds the chain; the statements are in
  `persistence/audit/prisma-audit-chain-store.ts` (`AUDIT_CHAIN_STORE`, through `auditTx`).
  - `audit-hash.ts`: `row_hash` and `chain_hash` v1 (PA 6.2). The fallback form is used only
    when `canonicalJson` refuses the row as read (Hassan N1 c); golden vectors in its spec.
  - `audit-chain-policy.ts`: every constant (S = 5 min, batch 500, checkpoint 1 h or 10 000
    seals, heartbeat 24 h, lag 15 min, stall 3 runs). Its spec fails the build when a unit or
    statement timeout ceiling is raised without S (S >= 4 x (30 s + 30 s)).
- Every read of the chain tables is bounded to `AUDIT_TIME_RANGE` (`audit-chain-policy.ts`):
  `[2000-01-01, 10000-01-01)` on `occurred_at`, `sealed_at`, `audit_occurred_at` and
  `created_at`, the range of the CHECKs tracked as DP 11.15. A JavaScript Date cannot hold
  `infinity`; out-of-range rows are never sealed and the verifier names them by id. An
  incremental run looks for out-of-range seals only from its walk's start up (no upper bound)
  and in unknown epochs; a full run looks at all of the Market's seals (Mojtaba D1).
- Runbook: Prisma's query log prints the upper bound as `+010000-01-01T00:00:00.000Z`. That
  literal is not valid if pasted into psql ("time zone displacement out of range"); write
  `'10000-01-01 00:00:00+00'` instead. The adapter itself sends a form PostgreSQL accepts.
- The sealer (`platform.audit-seal`, worker only, every 10 s, from start): one read-write
  unit per batch. It checks the head's link, stops a Market whose head link is broken
  (`audit.chain.broken`) or whose watermark is later than `now - S`
  (`audit.seal.watermark-future`), seals settled rows above the watermark, and, on the first
  run and every 5 min, unsealed rows of the last 24 h below it (`late`). A lost race (primary
  key, `55P03`, `40P01`) ends the run at info level with its SQLSTATE; a re-selected row with
  an unmoved head is `audit.seal.duplicate-row`; a taken checkpoint position is
  `audit.checkpoint.conflict`. The constraint name, not a guess, tells them apart. A run that
  throws alerts `audit.seal.failed` and counts toward `audit.seal.stalled`.
- Checkpoints are rows in the batch unit; the `AnchorSink` (Phase 2: `LogAnchorSink`, a log
  line `audit.checkpoint` or `audit.heartbeat` at info level) gets each checkpoint and a
  daily heartbeat after commit. A failed anchor is `audit.anchor.failed`; sealing goes on.
  The worker refuses a `LOG_LEVEL` above `info`, which would drop the anchor lines.
- The verifier (`platform.audit-verify`, hourly; full on the first run of a process and every
  24 h): read-only units only (ADR-0025), at most 9 minutes a run (then
  `audit.verify.incomplete`). It pins the head after reading the anchors, then recomputes
  every link and row hash and runs checks (a) to (k) of PA 8. Each finding is one error line
  with `alert: true`, the Market, epoch, `chainSeq` (text) and audit id: never row content.
  At most 1 000 lines per code, then one line with `suppressed`; the report counts them all
  (`findingTotals`). It changes nothing.
- Operator command: `APP_ROLE=api node dist/audit-verify.js --market <id> [--full]`
  (incremental unless `--full`; it loads the same configuration as the api, so `APP_ROLE`
  is required as everywhere). It prints one JSON line of positions, codes and counts and
  exits 0 when clean, 2 with findings (a finding wins over an incomplete run), 3 when the
  verification did not complete and found nothing (budget spent, or an error: stderr gets the
  error class and SQLSTATE, never its text), 1 when refused (usage, a Market this stack does
  not host, a failed start). An incomplete full run of the job is retried full.
  - Runbook note (Kazem): run it in the api image of the Region Stack that hosts the Market,
    with the stack's api environment (`DATABASE_URL` of the api login, `HOSTED_MARKETS`). It
    only reads. Exit 2: read the alert lines of the same run (`msg` = the code) for positions;
    exit 3: run it again, then with `--full`; repeated 3s go to Mojtaba (database) and Hassan.
    `audit.verify.incomplete` on consecutive job runs means a full run does not fit the
    budget (it is retried full every hour): tune the verify budget or `VERIFY_BATCH_SIZE` (`audit-chain-policy.ts`).
- Tests: unit specs over `test/support/in-memory-audit-chain.ts`;
  `test/db/platform-audit-chain.db-spec.ts` runs on its own database copy (`audit`), where
  the owner tampers and resets the chain with the user triggers off.

## Raw read port (ADR-0030)

`RAW_READ_PORT` (`raw-reads/raw-read-port.ts`) runs a read that Prisma cannot express. It is
read-only and Market-bound:

- A module gets its port only through `PersistenceModule.rawReadFor('<module>')` in its Nest
  module (`providers: [...]`); `PersistenceModule` does not export the unbound port. The bound
  port refuses a statement owned by another module with `wrong-module`, at run time, on top of
  the call-site check of `pnpm boundaries`. The boundary check is best effort against
  `createRequire`, `module.require`, aliased Prisma builders and `@prisma/client/runtime`
  imports (Hassan R-2); review catches those.
- It needs an open read-only unit (ADR-0025) of the asked Market; a read-write unit, no unit or
  a Market that differs from the unit's is refused before any database call.
- One unnamed statement goes out on the pool: no `BEGIN`, no transaction. `$1` is the Market,
  bound by the helper from the unit; `$2` onwards are the declared parameters, type-checked
  and, for arrays, capped (at most 1000) and, when zipped by one `unnest`, of equal length. A
  `uuid` is lower case; callers normalise first.
- Statements live only in `raw-reads/statements.ts` (CODEOWNERS: sign-off of Ali, Hassan and
  Mojtaba, plus Mojtaba's plan review). The pure checker (`statement-check.ts`) allows one
  `SELECT` over the owner's own tables with `<alias>.market_id = $1` per relation, `unnest`
  over bound parameters, INNER and LEFT joins only, and refuses locking, `INTO`, recursive or
  data-modifying CTEs, RIGHT and FULL joins, column alias lists, other functions, operators
  and casts.
- The same checker runs at start-up (`createRawReadPort`), in `pnpm boundaries` (which also
  bans raw SQL and the `pg` driver outside the named platform files and checks each
  `.rawRead(market, '<id>', ...)` call site) and, as a backstop, `EXPLAIN (GENERIC_PLAN)` in
  the database tests.
- The parser is `libpg-query`, pinned exactly and bumped together with the PostgreSQL major
  (17 today; the tests assert parser version 170007). Only `raw-reads/pg-parser.ts` imports it.
