-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The tracking module (work package 06): tracking's view of each delivery, the breadcrumb trail
-- of a delivery while a courier carries it, and the customer tracking links. Live positions are
-- in Redis. A trail is live-location personal data (Privacy Act): the `tracking.purge-expired`
-- job deletes it after the Market's retention, so the application may DELETE here.
CREATE SCHEMA IF NOT EXISTS "tracking";

CREATE TABLE "tracking"."tracked_deliveries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "courier_id" VARCHAR(64),
    "vehicle" VARCHAR(16),
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lng" DOUBLE PRECISION NOT NULL,
    "dropoff_lat" DOUBLE PRECISION NOT NULL,
    "dropoff_lng" DOUBLE PRECISION NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "tracked_deliveries_pkey" PRIMARY KEY ("market_id", "delivery_id")
);
CREATE INDEX "tracked_deliveries_market_id_courier_id_idx" ON "tracking"."tracked_deliveries"("market_id", "courier_id");
CREATE INDEX "tracked_deliveries_market_id_ended_at_idx" ON "tracking"."tracked_deliveries"("market_id", "ended_at");

ALTER TABLE "tracking"."tracked_deliveries"
  ADD CONSTRAINT "tracked_deliveries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "tracked_deliveries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "tracked_deliveries_status_check" CHECK ("status" IN ('SCHEDULED', 'DISPATCHING',
    'ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'AT_DROPOFF', 'DELIVERED', 'DELIVERY_FAILED',
    'RETURNING', 'RETURNED', 'CANCELLED')),
  ADD CONSTRAINT "tracked_deliveries_courier_id_check" CHECK ("courier_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD CONSTRAINT "tracked_deliveries_vehicle_check" CHECK ("vehicle" IN ('bicycle', 'motorbike', 'car', 'van')),
  ADD CONSTRAINT "tracked_deliveries_points_check" CHECK (
    "pickup_lat" BETWEEN -90 AND 90 AND "dropoff_lat" BETWEEN -90 AND 90
    AND "pickup_lng" BETWEEN -180 AND 180 AND "dropoff_lng" BETWEEN -180 AND 180),
  ADD CONSTRAINT "tracked_deliveries_version_check" CHECK ("version" >= 1);

CREATE TABLE "tracking"."breadcrumbs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_metres" INTEGER NOT NULL,

    CONSTRAINT "breadcrumbs_pkey" PRIMARY KEY ("market_id", "delivery_id", "recorded_at")
);
CREATE INDEX "breadcrumbs_market_id_recorded_at_idx" ON "tracking"."breadcrumbs"("market_id", "recorded_at");

ALTER TABLE "tracking"."breadcrumbs"
  ADD CONSTRAINT "breadcrumbs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "breadcrumbs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "breadcrumbs_courier_id_check" CHECK ("courier_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD CONSTRAINT "breadcrumbs_point_check" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180),
  ADD CONSTRAINT "breadcrumbs_accuracy_metres_check" CHECK ("accuracy_metres" BETWEEN 0 AND 10000);

CREATE TABLE "tracking"."links" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "delivery_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "links_pkey" PRIMARY KEY ("market_id", "token_hash")
);
CREATE INDEX "links_market_id_expires_at_idx" ON "tracking"."links"("market_id", "expires_at");

ALTER TABLE "tracking"."links"
  ADD CONSTRAINT "links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "links_expiry_check" CHECK ("expires_at" > "created_at");

-- Grants (database-designer): the application reads and writes tracking; only the status, the
-- courier and the end of a tracked delivery change; breadcrumbs and links are never edited,
-- only deleted by the retention job.
GRANT USAGE ON SCHEMA "tracking" TO "drive_app";
GRANT SELECT, INSERT, DELETE ON TABLE "tracking"."tracked_deliveries" TO "drive_app";
GRANT UPDATE ("status", "courier_id", "vehicle", "updated_at", "ended_at", "version")
  ON TABLE "tracking"."tracked_deliveries" TO "drive_app";
GRANT SELECT, INSERT, DELETE ON TABLE "tracking"."breadcrumbs" TO "drive_app";
GRANT SELECT, INSERT, DELETE ON TABLE "tracking"."links" TO "drive_app";
