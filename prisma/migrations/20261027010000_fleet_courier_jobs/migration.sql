-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Fleet follows the deliveries couriers carry (handoff 31): its subscribers to
-- delivery.status-changed and delivery.cancelled keep one row per delivery with the courier who
-- carries it now and the last delivery aggregate version applied, so a late or repeated event
-- never moves a job back and a finished job never reopens. A courier with an open job is busy:
-- dispatch offers them no work and they cannot go offline. Each event is handled once through
-- the module's inbox (platform persistence design 6.4).

-- CreateTable
CREATE TABLE "fleet"."courier_jobs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "courier_account_id" VARCHAR(64),
    "assigned_at" TIMESTAMPTZ(6),
    "ended" BOOLEAN NOT NULL,
    "delivery_version" INTEGER NOT NULL,

    CONSTRAINT "courier_jobs_pkey" PRIMARY KEY ("market_id","delivery_id")
);

-- CreateTable
CREATE TABLE "fleet"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE INDEX "courier_jobs_market_id_courier_account_id_idx" ON "fleet"."courier_jobs"("market_id", "courier_account_id");

-- A courier is set exactly with the time they were given the job, and a finished job keeps none
-- (no personal data stays behind it).
ALTER TABLE "fleet"."courier_jobs"
  ADD CONSTRAINT "courier_jobs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "courier_jobs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "courier_jobs_delivery_version_check" CHECK ("delivery_version" >= 1),
  ADD CONSTRAINT "courier_jobs_courier_check" CHECK (("courier_account_id" IS NULL) = ("assigned_at" IS NULL)),
  ADD CONSTRAINT "courier_jobs_ended_check" CHECK (NOT "ended" OR "courier_account_id" IS NULL);

ALTER TABLE "fleet"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^fleet\.[a-z0-9-]+$');

-- Grants (database-designer): a job changes its courier, its end and the applied version, and is
-- never deleted; the inbox is append-only.
GRANT SELECT, INSERT ON TABLE "fleet"."courier_jobs" TO "drive_app";
GRANT UPDATE ("courier_account_id", "assigned_at", "ended", "delivery_version") ON TABLE "fleet"."courier_jobs" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "fleet"."inbox" TO "drive_app";
