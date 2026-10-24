-- Payouts behind the gate (handoff 24): the module's outbox and inbox (platform persistence
-- design 5 and 6, as dispatch's), the provider time of an account's stored state (security
-- review L1), and the hold reason a pending line takes when its account can no longer be paid
-- out at sending (L5).

-- AlterTable
ALTER TABLE "payouts"."payout_accounts" ADD COLUMN "provider_state_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "payouts"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "payouts"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "payouts"."outbox"("market_id", "aggregate_id", "aggregate_version");

ALTER TABLE "payouts"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^payouts\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay's claim (platform persistence design 6.1). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "payouts"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

ALTER TABLE "payouts"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^payouts\.[a-z0-9-]+$');

-- Grants (database-designer): the outbox envelope is immutable and the inbox append-only; an
-- account's stored provider time changes with its state, and a pending line held at sending
-- takes its hold reason.
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "payouts"."outbox" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."inbox" TO "drive_app";
GRANT UPDATE ("provider_state_at") ON TABLE "payouts"."payout_accounts" TO "drive_app";
GRANT UPDATE ("hold_reason") ON TABLE "payouts"."payout_lines" TO "drive_app";
