-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Dispatch behind the gate (wave 2, handoff 22): what a courier's offer shows, kept on the job
-- only while it is OFFERING, and the delivery version the job last followed, so that delivery
-- events arriving late or twice change nothing. A scheduled job may open early. A job whose
-- courier collected the parcel is COLLECTED and can no longer be reassigned.

-- AlterTable
ALTER TABLE "dispatch"."jobs"
  ADD COLUMN "pickup_address" VARCHAR(500),
  ADD COLUMN "dropoff_address" VARCHAR(500),
  ADD COLUMN "dropoff_lat" DOUBLE PRECISION,
  ADD COLUMN "dropoff_lng" DOUBLE PRECISION,
  ADD COLUMN "trip_distance_metres" INTEGER,
  ADD COLUMN "delivery_version" INTEGER NOT NULL DEFAULT 0;

-- Hand-written: value checks that mirror the domain.
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
  ),
  ADD CONSTRAINT "jobs_delivery_version_check" CHECK ("delivery_version" >= 0);

ALTER TABLE "dispatch"."jobs"
  DROP CONSTRAINT "jobs_status_check",
  DROP CONSTRAINT "jobs_assignment_check",
  ADD CONSTRAINT "jobs_status_check" CHECK ("status" IN ('WAITING', 'OFFERING', 'ASSIGNED', 'EXHAUSTED', 'COLLECTED', 'CANCELLED')),
  ADD CONSTRAINT "jobs_assignment_check" CHECK (
    ("status" IN ('ASSIGNED', 'COLLECTED') AND "assigned_courier_id" IS NOT NULL
      AND "assigned_vehicle" IS NOT NULL AND "assignment_method" IN ('offer', 'manual')
      AND "assigned_at" IS NOT NULL)
    OR ("status" <> 'ASSIGNED' AND "assigned_courier_id" IS NULL AND "assigned_vehicle" IS NULL
      AND "assignment_method" IS NULL AND "assigned_at" IS NULL)
  );

-- Grants: the new columns change with the job; a scheduled job's opening time may move earlier.
GRANT UPDATE ("opens_at", "pickup_address", "dropoff_address", "dropoff_lat", "dropoff_lng", "trip_distance_metres", "delivery_version") ON TABLE "dispatch"."jobs" TO "drive_app";
