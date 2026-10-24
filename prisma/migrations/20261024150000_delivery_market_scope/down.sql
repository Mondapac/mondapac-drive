-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261024150000_delivery_market_scope: the grants, then the columns and CHECKs, and
-- the plain geography columns of 20261024130000_delivery_core. Fails once a delivery is stored,
-- since the restored point columns are NOT NULL without a value, which is right: data is never
-- dropped by a down migration.
REVOKE SELECT, INSERT ON TABLE "delivery"."delivery_events" FROM "drive_app";
REVOKE UPDATE ("status", "courier_id", "version") ON TABLE "delivery"."deliveries" FROM "drive_app";
REVOKE SELECT, INSERT ON TABLE "delivery"."deliveries" FROM "drive_app";
REVOKE USAGE ON SCHEMA "delivery" FROM "drive_app";

ALTER TABLE "delivery"."delivery_events"
  DROP CONSTRAINT "delivery_events_market_id_delivery_id_fkey",
  DROP CONSTRAINT "delivery_events_pkey";
DROP INDEX "delivery"."deliveries_market_id_id_key";
ALTER TABLE "delivery"."delivery_events"
  ADD CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("delivery_id", "sequence"),
  ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id")
    REFERENCES "delivery"."deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delivery"."delivery_events"
  DROP CONSTRAINT "delivery_events_tenant_id_check",
  DROP CONSTRAINT "delivery_events_market_id_check",
  DROP COLUMN "tenant_id";

ALTER TABLE "delivery"."deliveries"
  DROP CONSTRAINT "deliveries_points_check",
  DROP CONSTRAINT "deliveries_tenant_id_check";
DROP INDEX "delivery"."deliveries_pickup_point_idx";
ALTER TABLE "delivery"."deliveries"
  DROP COLUMN "pickup_point",
  DROP COLUMN "dropoff_point";
ALTER TABLE "delivery"."deliveries"
  ADD COLUMN "pickup_point" geography(Point, 4326) NOT NULL,
  ADD COLUMN "dropoff_point" geography(Point, 4326) NOT NULL;
CREATE INDEX "deliveries_pickup_point_idx" ON "delivery"."deliveries" USING GIST ("pickup_point");
ALTER TABLE "delivery"."deliveries"
  DROP COLUMN "dropoff_lng",
  DROP COLUMN "dropoff_lat",
  DROP COLUMN "pickup_lng",
  DROP COLUMN "pickup_lat",
  DROP COLUMN "tenant_id";
