-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The delivery tables join the platform's market guard (copied from the marketplace): every row
-- carries tenant_id next to market_id. Points become latitude and longitude columns that Prisma
-- writes; the PostGIS geography columns are generated from them, so no raw SQL is needed to save
-- a delivery. No delivery has been stored yet (the module used an in-memory store), so the columns
-- are added without defaults.
ALTER TABLE "delivery"."deliveries"
  ADD COLUMN "tenant_id" TEXT NOT NULL,
  ADD COLUMN "pickup_lat" DOUBLE PRECISION NOT NULL,
  ADD COLUMN "pickup_lng" DOUBLE PRECISION NOT NULL,
  ADD COLUMN "dropoff_lat" DOUBLE PRECISION NOT NULL,
  ADD COLUMN "dropoff_lng" DOUBLE PRECISION NOT NULL;

DROP INDEX "delivery"."deliveries_pickup_point_idx";
ALTER TABLE "delivery"."deliveries"
  DROP COLUMN "pickup_point",
  DROP COLUMN "dropoff_point";
ALTER TABLE "delivery"."deliveries"
  ADD COLUMN "pickup_point" geography(Point, 4326)
    GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("pickup_lng", "pickup_lat"), 4326)::geography) STORED,
  ADD COLUMN "dropoff_point" geography(Point, 4326)
    GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("dropoff_lng", "dropoff_lat"), 4326)::geography) STORED;
CREATE INDEX "deliveries_pickup_point_idx" ON "delivery"."deliveries" USING GIST ("pickup_point");

ALTER TABLE "delivery"."deliveries"
  ADD CONSTRAINT "deliveries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "deliveries_points_check" CHECK (
    "pickup_lat" BETWEEN -90 AND 90 AND "dropoff_lat" BETWEEN -90 AND 90
    AND "pickup_lng" BETWEEN -180 AND 180 AND "dropoff_lng" BETWEEN -180 AND 180);

ALTER TABLE "delivery"."delivery_events"
  ADD COLUMN "tenant_id" TEXT NOT NULL,
  ADD CONSTRAINT "delivery_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "delivery_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- An event belongs to a delivery of its own Market: the key and the foreign key carry market_id
-- (platform persistence PM6), so no join can cross Markets.
ALTER TABLE "delivery"."delivery_events"
  DROP CONSTRAINT "delivery_events_delivery_id_fkey",
  DROP CONSTRAINT "delivery_events_pkey";
CREATE UNIQUE INDEX "deliveries_market_id_id_key" ON "delivery"."deliveries"("market_id", "id");
ALTER TABLE "delivery"."delivery_events"
  ADD CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("market_id", "delivery_id", "sequence"),
  ADD CONSTRAINT "delivery_events_market_id_delivery_id_fkey" FOREIGN KEY ("market_id", "delivery_id")
    REFERENCES "delivery"."deliveries"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Grants (database-designer): the application login reads and writes deliveries, and only
-- appends events. The identity, market and money columns of a delivery never change.
GRANT USAGE ON SCHEMA "delivery" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "delivery"."deliveries" TO "drive_app";
GRANT UPDATE ("status", "courier_id", "version") ON TABLE "delivery"."deliveries" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "delivery"."delivery_events" TO "drive_app";
