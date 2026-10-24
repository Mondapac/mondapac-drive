-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Proof of delivery the server checks (handoff 21, PR 2). The recipient's PIN is derived from the
-- delivery id with the deployment's key and stored nowhere; only the count of wrong PINs is kept,
-- outside the version, so that a delivery takes a limited number of guesses.
ALTER TABLE "delivery"."deliveries"
  ADD COLUMN "wrong_pins" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "deliveries_wrong_pins_check" CHECK ("wrong_pins" BETWEEN 0 AND 100);

-- A courier's proof photo: the bytes are in private object storage under storage_key, which the
-- server builds and never returns. A photo belongs to a delivery of its own Market (PM6).
CREATE TABLE "delivery"."proof_photos" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "media_type" VARCHAR(16) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "proof_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "proof_photos_market_id_id_key" ON "delivery"."proof_photos"("market_id", "id");
CREATE INDEX "proof_photos_market_id_delivery_id_idx" ON "delivery"."proof_photos"("market_id", "delivery_id");

ALTER TABLE "delivery"."proof_photos"
  ADD CONSTRAINT "proof_photos_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "proof_photos_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "proof_photos_media_type_check" CHECK ("media_type" IN ('image/jpeg', 'image/png')),
  ADD CONSTRAINT "proof_photos_size_bytes_check" CHECK ("size_bytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "proof_photos_market_id_delivery_id_fkey" FOREIGN KEY ("market_id", "delivery_id")
    REFERENCES "delivery"."deliveries"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Grants (database-designer): the wrong-PIN count is updated in place; photos are append-only.
GRANT UPDATE ("wrong_pins") ON TABLE "delivery"."deliveries" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "delivery"."proof_photos" TO "drive_app";
