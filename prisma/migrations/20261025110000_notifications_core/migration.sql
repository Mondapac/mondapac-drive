-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The notifications module (handoff 11): merchant webhook subscriptions, the webhook calls and
-- recipient SMS queued for delivery changes, with their retry state. No personal data is stored:
-- a recipient's number is read from the delivery module when an SMS is sent, and signing
-- secrets are derived from the deployment's key and secret_version, never stored.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notifications";

-- CreateTable
CREATE TABLE "notifications"."webhook_subscriptions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "merchant_id" VARCHAR(64) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "event_types" TEXT[],
    "secret_version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."webhook_calls" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "dead_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."sms_messages" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "event_id" UUID NOT NULL,
    "reference" VARCHAR(128) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "provider_message_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "dead_at" TIMESTAMPTZ(6),

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_subscriptions_market_id_merchant_id_idx" ON "notifications"."webhook_subscriptions"("market_id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_market_id_id_key" ON "notifications"."webhook_subscriptions"("market_id", "id");

-- CreateIndex
CREATE INDEX "webhook_calls_market_id_status_next_attempt_at_idx" ON "notifications"."webhook_calls"("market_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_calls_market_id_subscription_id_event_id_key" ON "notifications"."webhook_calls"("market_id", "subscription_id", "event_id");

-- CreateIndex
CREATE INDEX "sms_messages_market_id_status_next_attempt_at_idx" ON "notifications"."sms_messages"("market_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "sms_messages_market_id_delivery_id_kind_key" ON "notifications"."sms_messages"("market_id", "delivery_id", "kind");

-- AddForeignKey
ALTER TABLE "notifications"."webhook_calls" ADD CONSTRAINT "webhook_calls_market_id_subscription_id_fkey" FOREIGN KEY ("market_id", "subscription_id") REFERENCES "notifications"."webhook_subscriptions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: value checks that mirror the domain.
ALTER TABLE "notifications"."webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "webhook_subscriptions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "webhook_subscriptions_url_check" CHECK ("url" ~ '^https://'),
  ADD CONSTRAINT "webhook_subscriptions_event_types_check" CHECK (
    "event_types" IS NOT NULL AND cardinality("event_types") >= 1
    AND "event_types" <@ ARRAY['delivery.booked', 'delivery.status-changed', 'delivery.cancelled']::TEXT[]),
  ADD CONSTRAINT "webhook_subscriptions_secret_version_check" CHECK ("secret_version" >= 1),
  ADD CONSTRAINT "webhook_subscriptions_status_check" CHECK ("status" IN ('active', 'disabled')),
  ADD CONSTRAINT "webhook_subscriptions_version_check" CHECK ("version" >= 1);

ALTER TABLE "notifications"."webhook_calls"
  ADD CONSTRAINT "webhook_calls_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "webhook_calls_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "webhook_calls_status_check" CHECK (
    ("status" = 'pending' AND "next_attempt_at" IS NOT NULL AND "sent_at" IS NULL AND "dead_at" IS NULL)
    OR ("status" = 'sent' AND "next_attempt_at" IS NULL AND "sent_at" IS NOT NULL)
    OR ("status" = 'dead' AND "next_attempt_at" IS NULL AND "dead_at" IS NOT NULL)),
  ADD CONSTRAINT "webhook_calls_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "webhook_calls_body_check" CHECK (jsonb_typeof("body"::jsonb) = 'object');

ALTER TABLE "notifications"."sms_messages"
  ADD CONSTRAINT "sms_messages_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sms_messages_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sms_messages_kind_check" CHECK ("kind" IN ('booked', 'on_the_way', 'delivered', 'failed')),
  ADD CONSTRAINT "sms_messages_status_check" CHECK (
    ("status" = 'pending' AND "next_attempt_at" IS NOT NULL AND "sent_at" IS NULL AND "dead_at" IS NULL)
    OR ("status" = 'sent' AND "next_attempt_at" IS NULL AND "sent_at" IS NOT NULL)
    OR ("status" = 'dead' AND "next_attempt_at" IS NULL AND "dead_at" IS NOT NULL)),
  ADD CONSTRAINT "sms_messages_attempts_check" CHECK ("attempts" >= 0);

-- Grants (database-designer): a subscription keeps its merchant and URL; a queued call keeps its
-- subscription, event and body; an SMS keeps its delivery, kind and reference. Only the retry
-- state changes. No DELETE until a retention job needs it.
GRANT USAGE ON SCHEMA "notifications" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "notifications"."webhook_subscriptions" TO "drive_app";
GRANT UPDATE ("secret_version", "status", "version") ON TABLE "notifications"."webhook_subscriptions" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "notifications"."webhook_calls" TO "drive_app";
GRANT UPDATE ("status", "attempts", "next_attempt_at", "last_status_code", "last_error_code", "sent_at", "dead_at")
  ON TABLE "notifications"."webhook_calls" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "notifications"."sms_messages" TO "drive_app";
GRANT UPDATE ("status", "attempts", "next_attempt_at", "last_error_code", "provider_message_id", "sent_at", "dead_at")
  ON TABLE "notifications"."sms_messages" TO "drive_app";
