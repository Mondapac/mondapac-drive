-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Courier push devices (handoff 33): one per courier session, the Expo token sealed (AES-GCM)
-- and found by its keyed digest. Rows are deleted on sign-out, when identity ends the account's
-- sessions, and when the push service no longer knows the token.

-- CreateTable
CREATE TABLE "notifications"."push_devices" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "platform" VARCHAR(8) NOT NULL,
    "token_sealed" VARCHAR(512) NOT NULL,
    "token_lookup" CHAR(64) NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_devices_market_id_account_id_idx" ON "notifications"."push_devices"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_market_id_session_id_key" ON "notifications"."push_devices"("market_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_market_id_token_lookup_key" ON "notifications"."push_devices"("market_id", "token_lookup");

-- Hand-written: value checks that mirror the domain. The sealed token is never the clear one.
ALTER TABLE "notifications"."push_devices"
  ADD CONSTRAINT "push_devices_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "push_devices_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "push_devices_platform_check" CHECK ("platform" IN ('ios', 'android')),
  ADD CONSTRAINT "push_devices_token_sealed_check" CHECK ("token_sealed" ~ '^v1\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "push_devices_token_lookup_check" CHECK ("token_lookup" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "push_devices_expiry_check" CHECK ("expires_at" > "registered_at");

-- Grants (database-designer): a device is registered and dropped, never changed.
GRANT SELECT, INSERT, DELETE ON TABLE "notifications"."push_devices" TO "drive_app";
