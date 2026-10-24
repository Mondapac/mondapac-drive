-- The platform runtime's tables, copied from the marketplace (Mondapac/mondapac-marketplace-platform
-- at a87dd54f) as one migration: its baseline, subject keys, btree_gist, event delivery, audit seal
-- and rate-limit counter migrations, folded to their final state. Section numbers in comments refer
-- to the marketplace's design documents. The group role "drive_app" is created by the cluster
-- bootstrap (scripts/db/bootstrap-dev.sql), never by a migration; without it this migration fails
-- with 42704, on purpose.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateTable
CREATE TABLE "platform"."audit_log" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "acting_as_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_market_id_target_type_target_id_occurred_at_idx" ON "platform"."audit_log"("market_id", "target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_market_id_actor_id_occurred_at_idx" ON "platform"."audit_log"("market_id", "actor_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_market_id_occurred_at_id_key" ON "platform"."audit_log"("market_id", "occurred_at", "id");

-- Hand-written (database-designer): integrity backstops Prisma cannot express.
ALTER TABLE "platform"."audit_log"
  ADD CONSTRAINT "audit_log_market_id_check" CHECK ("market_id" <> ''),
  ADD CONSTRAINT "audit_log_tenant_id_check" CHECK ("tenant_id" <> ''),
  ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  ADD CONSTRAINT "audit_log_occurred_at_check" CHECK ("occurred_at" = date_trunc('milliseconds', "occurred_at", 'UTC')),
  ADD CONSTRAINT "audit_log_before_size_check" CHECK (octet_length("before"::text) <= 8192),
  ADD CONSTRAINT "audit_log_after_size_check" CHECK (octet_length("after"::text) <= 8192),
  ADD CONSTRAINT "audit_log_actor_check" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)),
  ADD CONSTRAINT "audit_log_acting_as_check" CHECK ("acting_as_id" IS NULL OR ("actor_id" IS NOT NULL AND "acting_as_id" <> "actor_id")),
  ADD CONSTRAINT "audit_log_action_check" CHECK ("action" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("action") <= 128),
  ADD CONSTRAINT "audit_log_target_type_check" CHECK ("target_type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("target_type") <= 128),
  ADD CONSTRAINT "audit_log_target_id_check" CHECK (char_length("target_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "audit_log_before_check" CHECK ("before" IS NULL OR jsonb_typeof("before") = 'object'),
  ADD CONSTRAINT "audit_log_after_check" CHECK ("after" IS NULL OR jsonb_typeof("after") = 'object'),
  ADD CONSTRAINT "audit_log_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

-- Hand-written (database-designer): append-only enforcement (ADR-0004 decision 7, ADR-0009 V4).
CREATE FUNCTION "platform"."audit_log_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform.audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_log_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_log_reject_mutation"();

CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_log_reject_mutation"();

-- Grants (database-designer): docs/design/data/platform.md section 10.
GRANT USAGE ON SCHEMA "platform" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "platform"."audit_log" TO "drive_app";

-- CreateTable
CREATE TABLE "platform"."subject_keys" (
    "subject_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "wrapped_key" TEXT,
    "wrapping_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "rewrapped_at" TIMESTAMPTZ(6),
    "destroyed_at" TIMESTAMPTZ(6),

    CONSTRAINT "subject_keys_pkey" PRIMARY KEY ("subject_id")
);

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.2.
-- The wrapped-key limit stands until Kazem fixes the format (data design 11.4, K1).
ALTER TABLE "platform"."subject_keys"
  ADD CONSTRAINT "subject_keys_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "subject_keys_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "subject_keys_key_version_check" CHECK ("key_version" >= 1),
  ADD CONSTRAINT "subject_keys_wrapped_key_check" CHECK (char_length("wrapped_key") <= 1024),
  ADD CONSTRAINT "subject_keys_wrapping_key_id_check" CHECK (char_length("wrapping_key_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "subject_keys_tombstone_check" CHECK (("destroyed_at" IS NULL) = ("wrapped_key" IS NOT NULL));

-- Hand-written (database-designer): docs/design/data/identity.md 3.2. The tombstone is one-way
-- and the identity columns are frozen, for every role, the owner included (PF 4 row 5).
CREATE FUNCTION "platform"."subject_keys_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."destroyed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'platform.subject_keys: a destroyed key cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."subject_id", NEW."market_id", NEW."tenant_id", NEW."key_version", NEW."created_at")
     IS DISTINCT FROM
     (OLD."subject_id", OLD."market_id", OLD."tenant_id", OLD."key_version", OLD."created_at") THEN
    RAISE EXCEPTION 'platform.subject_keys: identity columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subject_keys_one_way"
  BEFORE UPDATE ON "platform"."subject_keys"
  FOR EACH ROW EXECUTE FUNCTION "platform"."subject_keys_guard_update"();

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE ("wrapped_key", "wrapping_key_id", "rewrapped_at", "destroyed_at") ON TABLE "platform"."subject_keys" TO "drive_app";

-- The btree_gist extension in its own schema (docs/design/data/sellers.md 9.2, ADR-0023
-- decision 5, Ali's O1 ruling). Exclusion constraints on `=` of market and seller ids need it
-- (sellers tax registration periods, and other modules' V2 records later).
--
-- No grant on purpose: `drive_app` has no USAGE on "extensions", yet inserts and updates
-- through the index and is refused on overlap, since index maintenance needs no USAGE or
-- EXECUTE. "extensions" is on nobody's search_path. btree_gist is a trusted extension, so the
-- migration role (database owner) creates it without a superuser.
CREATE SCHEMA "extensions";
CREATE EXTENSION "btree_gist" SCHEMA "extensions";

-- CreateTable
CREATE TABLE "platform"."event_delivery" (
    "event_id" UUID NOT NULL,
    "subscriber" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "dead_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_delivery_pkey" PRIMARY KEY ("event_id","subscriber")
);

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.8; the
-- envelope copy has the CHECKs of the outbox (3.1), with the type open to every module. A code
-- column (error_code) holds lower-case segments joined by "." (delivery.not-consumed), at most
-- 64 characters, as on sessions.revoked_reason.
ALTER TABLE "platform"."event_delivery"
  ADD CONSTRAINT "event_delivery_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "event_delivery_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "event_delivery_subscriber_check" CHECK ("subscriber" ~ '^[a-z][a-z0-9-]*\.[a-z0-9-]+$'),
  ADD CONSTRAINT "event_delivery_status_check" CHECK ("status" IN ('pending', 'delivered', 'dead')),
  ADD CONSTRAINT "event_delivery_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "event_delivery_type_check" CHECK ("type" ~ '^[a-z][a-z0-9-]*\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "event_delivery_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "event_delivery_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "event_delivery_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "event_delivery_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "event_delivery_error_code_check" CHECK (
    "error_code" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("error_code") <= 64),
  ADD CONSTRAINT "event_delivery_delivered_check" CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL)),
  ADD CONSTRAINT "event_delivery_dead_check" CHECK (("status" = 'dead') = ("dead_at" IS NOT NULL));

-- Hand-written (database-designer): docs/design/data/identity.md sections 3.8 and 8.4, the
-- dispatcher's claim (platform persistence design 6.4). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "event_delivery_market_id_next_attempt_at_pending_idx" ON "platform"."event_delivery" ("market_id", "next_attempt_at") WHERE "status" = 'pending';

-- Grants (database-designer): docs/design/data/identity.md section 7. The envelope copy is
-- immutable to the application; DELETE arrives with the prune job (P 7).
GRANT SELECT, INSERT, UPDATE ("status", "attempts", "next_attempt_at", "error_code", "delivered_at", "dead_at") ON TABLE "platform"."event_delivery" TO "drive_app";

-- CreateTable
CREATE TABLE "platform"."audit_log_seal" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "chain_seq" BIGINT NOT NULL,
    "audit_log_id" UUID NOT NULL,
    "audit_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "row_hash" BYTEA NOT NULL,
    "chain_hash" BYTEA NOT NULL,
    "late" BOOLEAN NOT NULL,
    "hash_version" SMALLINT NOT NULL,
    "sealed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_log_seal_pkey" PRIMARY KEY ("market_id","epoch","chain_seq")
);

-- CreateTable
CREATE TABLE "platform"."audit_chain_checkpoint" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "chain_seq" BIGINT NOT NULL,
    "chain_hash" BYTEA NOT NULL,
    "hash_version" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_chain_checkpoint_pkey" PRIMARY KEY ("market_id","epoch","chain_seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seal_market_id_epoch_occurred_at_id_key" ON "platform"."audit_log_seal"("market_id", "epoch", "audit_occurred_at", "audit_log_id");

-- AddForeignKey
ALTER TABLE "platform"."audit_log_seal" ADD CONSTRAINT "audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey" FOREIGN KEY ("market_id", "audit_occurred_at", "audit_log_id") REFERENCES "platform"."audit_log"("market_id", "occurred_at", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/platform.md 11.3 and 11.4.
ALTER TABLE "platform"."audit_log_seal"
  ADD CONSTRAINT "audit_log_seal_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "audit_log_seal_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "audit_log_seal_epoch_check" CHECK ("epoch" >= 1),
  ADD CONSTRAINT "audit_log_seal_chain_seq_check" CHECK ("chain_seq" >= 1),
  ADD CONSTRAINT "audit_log_seal_genesis_check" CHECK ("epoch" > 1 OR "chain_seq" > 1 OR NOT "late"),
  ADD CONSTRAINT "audit_log_seal_row_hash_check" CHECK (octet_length("row_hash") = 32),
  ADD CONSTRAINT "audit_log_seal_chain_hash_check" CHECK (octet_length("chain_hash") = 32),
  ADD CONSTRAINT "audit_log_seal_hash_version_check" CHECK ("hash_version" IN (1));

ALTER TABLE "platform"."audit_chain_checkpoint"
  ADD CONSTRAINT "audit_chain_checkpoint_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "audit_chain_checkpoint_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "audit_chain_checkpoint_epoch_check" CHECK ("epoch" >= 1),
  ADD CONSTRAINT "audit_chain_checkpoint_chain_seq_check" CHECK ("chain_seq" >= 1),
  ADD CONSTRAINT "audit_chain_checkpoint_chain_hash_check" CHECK (octet_length("chain_hash") = 32),
  ADD CONSTRAINT "audit_chain_checkpoint_hash_version_check" CHECK ("hash_version" IN (1));

-- Hand-written (database-designer): append-only enforcement for the seal and the checkpoints
-- (ADR-0004 decision 7, ADR-0009 V4; docs/design/data/platform.md 11.5).
CREATE FUNCTION "platform"."audit_chain_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_log_seal_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_log_seal"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_log_seal_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_log_seal"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_chain_checkpoint_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_chain_checkpoint"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_chain_checkpoint_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_chain_checkpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

-- Grants (database-designer): docs/design/data/platform.md section 11.6.
GRANT SELECT, INSERT ON TABLE "platform"."audit_log_seal" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "platform"."audit_chain_checkpoint" TO "drive_app";

-- Generic per-origin rate-limit counters in PostgreSQL (marketplace identity design 6.8
-- and 13), so every API instance counts one window.
-- The column names, their order and the key shape are fixed by the PostgreSQL store of
-- rate-limiter-flexible 11.2.1, whose INSERT lists no columns. The key carries the keyed hash
-- of the origin, never an address (identity data design HF3). No market_id: the limiter is the
-- cross-Market control (PF I11). Physical design: docs/design/data/platform.md section 12.

-- CreateTable
-- One UPDATE per API request: fillfactor leaves room for HOT updates, and autovacuum runs early.
CREATE TABLE "platform"."rate_limit_counters" (
    "key" VARCHAR(255) NOT NULL,
    "points" INTEGER NOT NULL,
    "expire" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);

-- A new limit class (RATE_LIMIT_CLASSES) needs a migration that widens this CHECK.
ALTER TABLE "platform"."rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|default):[0-9a-f]{64}$'),
  ADD CONSTRAINT "rate_limit_counters_points_check" CHECK ("points" >= 0),
  ADD CONSTRAINT "rate_limit_counters_expire_check" CHECK ("expire" > 0);

-- Grants (database-designer): docs/design/data/platform.md section 12.
-- The store counts with INSERT ... ON CONFLICT DO UPDATE ... RETURNING and purges ended windows.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."rate_limit_counters" TO "drive_app";
