-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Tracking follows the delivery lifecycle (handoff 26): its subscribers to delivery.booked,
-- delivery.status-changed and delivery.cancelled record the delivery aggregate version they
-- applied, so a late or repeated event never moves a delivery back, and each event is handled
-- once through the module's inbox (platform persistence design 6.4).

-- AlterTable
ALTER TABLE "tracking"."tracked_deliveries" ADD COLUMN "delivery_version" INTEGER;

ALTER TABLE "tracking"."tracked_deliveries"
  ADD CONSTRAINT "tracked_deliveries_delivery_version_check" CHECK ("delivery_version" IS NULL OR "delivery_version" >= 1);

-- CreateTable
CREATE TABLE "tracking"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

ALTER TABLE "tracking"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^tracking\.[a-z0-9-]+$');

-- Grants (database-designer): the applied version changes with the status; the inbox is
-- append-only.
GRANT UPDATE ("delivery_version") ON TABLE "tracking"."tracked_deliveries" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "tracking"."inbox" TO "drive_app";
