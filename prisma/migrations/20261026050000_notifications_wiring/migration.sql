-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Notifications wired to the delivery events (handoff 25): the module's inbox for at-most-once
-- handling of delivery.* events, a merchant can change a subscription's event types, and a
-- rotated-out secret signs next to the new one until previous_secret_valid_until.

-- AlterTable
ALTER TABLE "notifications"."webhook_subscriptions" ADD COLUMN "previous_secret_valid_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "notifications"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- Hand-written: value checks that mirror the domain.
ALTER TABLE "notifications"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^notifications\.[a-z0-9-]+$');

-- Grants (database-designer): the inbox is append-only; a subscription's event types and its
-- rotation overlap change, its merchant and URL never do.
GRANT SELECT, INSERT ON TABLE "notifications"."inbox" TO "drive_app";
GRANT UPDATE ("event_types", "previous_secret_valid_until") ON TABLE "notifications"."webhook_subscriptions" TO "drive_app";
