-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026020000_dispatch_offer_stops: the grants, the statuses, the checks, then the
-- columns.
REVOKE UPDATE ("opens_at", "pickup_address", "dropoff_address", "dropoff_lat", "dropoff_lng", "trip_distance_metres", "delivery_version") ON TABLE "dispatch"."jobs" FROM "drive_app";
-- A COLLECTED job goes back to ASSIGNED, the status it had before this migration knew it.
-- One with no courier recorded goes back to CANCELLED, the only status that held none.
ALTER TABLE "dispatch"."jobs"
  DROP CONSTRAINT "jobs_status_check",
  DROP CONSTRAINT "jobs_assignment_check";
UPDATE "dispatch"."jobs"
  SET "status" = CASE WHEN "assigned_courier_id" IS NULL THEN 'CANCELLED' ELSE 'ASSIGNED' END
  WHERE "status" = 'COLLECTED';
ALTER TABLE "dispatch"."jobs"
  ADD CONSTRAINT "jobs_status_check" CHECK ("status" IN ('WAITING', 'OFFERING', 'ASSIGNED', 'EXHAUSTED', 'CANCELLED')),
  ADD CONSTRAINT "jobs_assignment_check" CHECK (
    ("status" = 'ASSIGNED' AND "assigned_courier_id" IS NOT NULL AND "assigned_vehicle" IS NOT NULL
      AND "assignment_method" IN ('offer', 'manual') AND "assigned_at" IS NOT NULL)
    OR ("status" <> 'ASSIGNED' AND "assigned_courier_id" IS NULL AND "assigned_vehicle" IS NULL
      AND "assignment_method" IS NULL AND "assigned_at" IS NULL)
  );
ALTER TABLE "dispatch"."jobs"
  DROP CONSTRAINT "jobs_delivery_version_check",
  DROP CONSTRAINT "jobs_offer_stops_closed_check",
  DROP CONSTRAINT "jobs_offer_stops_check";
ALTER TABLE "dispatch"."jobs"
  DROP COLUMN "delivery_version",
  DROP COLUMN "trip_distance_metres",
  DROP COLUMN "dropoff_lng",
  DROP COLUMN "dropoff_lat",
  DROP COLUMN "dropoff_address",
  DROP COLUMN "pickup_address";
