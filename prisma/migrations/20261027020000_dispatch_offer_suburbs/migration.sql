-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Security L3 (wave 3, handoff 32): before a courier accepts, the offer shows each stop's suburb
-- and postcode, never its street address, so dispatch stops holding addresses at all. An open
-- offer's stops are dropped here: the job reads them again from delivery for its next wave, and
-- an offer out now shows again then.

ALTER TABLE "dispatch"."jobs"
  DROP CONSTRAINT "jobs_offer_stops_check",
  DROP CONSTRAINT "jobs_offer_stops_closed_check";
REVOKE UPDATE ("pickup_address", "dropoff_address") ON TABLE "dispatch"."jobs" FROM "drive_app";
UPDATE "dispatch"."jobs"
  SET "dropoff_lat" = NULL, "dropoff_lng" = NULL, "trip_distance_metres" = NULL
  WHERE "pickup_address" IS NOT NULL;

-- AlterTable
ALTER TABLE "dispatch"."jobs"
  DROP COLUMN "pickup_address",
  DROP COLUMN "dropoff_address",
  ADD COLUMN "pickup_suburb" VARCHAR(200),
  ADD COLUMN "pickup_postcode" VARCHAR(10),
  ADD COLUMN "dropoff_suburb" VARCHAR(200),
  ADD COLUMN "dropoff_postcode" VARCHAR(10);

-- Hand-written: value checks that mirror the domain.
ALTER TABLE "dispatch"."jobs"
  ADD CONSTRAINT "jobs_offer_stops_check" CHECK (
    ("pickup_postcode" IS NULL AND "dropoff_postcode" IS NULL AND "pickup_suburb" IS NULL
      AND "dropoff_suburb" IS NULL AND "dropoff_lat" IS NULL AND "dropoff_lng" IS NULL
      AND "trip_distance_metres" IS NULL)
    OR ("pickup_postcode" IS NOT NULL AND "dropoff_postcode" IS NOT NULL
      AND "dropoff_lat" BETWEEN -90 AND 90 AND "dropoff_lng" BETWEEN -180 AND 180
      AND "trip_distance_metres" >= 0)
  ),
  ADD CONSTRAINT "jobs_offer_stops_closed_check" CHECK (
    "status" = 'OFFERING' OR "pickup_postcode" IS NULL
  );

-- Grants: the stops change with the job.
GRANT UPDATE ("pickup_suburb", "pickup_postcode", "dropoff_suburb", "dropoff_postcode") ON TABLE "dispatch"."jobs" TO "drive_app";
