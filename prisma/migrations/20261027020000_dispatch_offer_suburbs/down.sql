-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027020000_dispatch_offer_suburbs: the address columns come back empty, so an
-- open offer's stops are dropped and read again from delivery for the job's next wave.
REVOKE UPDATE ("pickup_suburb", "pickup_postcode", "dropoff_suburb", "dropoff_postcode") ON TABLE "dispatch"."jobs" FROM "drive_app";
ALTER TABLE "dispatch"."jobs"
  DROP CONSTRAINT "jobs_offer_stops_check",
  DROP CONSTRAINT "jobs_offer_stops_closed_check";
UPDATE "dispatch"."jobs"
  SET "dropoff_lat" = NULL, "dropoff_lng" = NULL, "trip_distance_metres" = NULL
  WHERE "pickup_postcode" IS NOT NULL;
ALTER TABLE "dispatch"."jobs"
  DROP COLUMN "dropoff_postcode",
  DROP COLUMN "dropoff_suburb",
  DROP COLUMN "pickup_postcode",
  DROP COLUMN "pickup_suburb",
  ADD COLUMN "pickup_address" VARCHAR(500),
  ADD COLUMN "dropoff_address" VARCHAR(500);
ALTER TABLE "dispatch"."jobs"
  ADD CONSTRAINT "jobs_offer_stops_check" CHECK (
    ("pickup_address" IS NULL AND "dropoff_address" IS NULL AND "dropoff_lat" IS NULL
      AND "dropoff_lng" IS NULL AND "trip_distance_metres" IS NULL)
    OR ("pickup_address" IS NOT NULL AND "dropoff_address" IS NOT NULL
      AND "dropoff_lat" BETWEEN -90 AND 90 AND "dropoff_lng" BETWEEN -180 AND 180
      AND "trip_distance_metres" >= 0)
  ),
  ADD CONSTRAINT "jobs_offer_stops_closed_check" CHECK (
    "status" = 'OFFERING' OR "pickup_address" IS NULL
  );
GRANT UPDATE ("pickup_address", "dropoff_address") ON TABLE "dispatch"."jobs" TO "drive_app";
