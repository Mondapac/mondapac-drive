-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026020000_dispatch_offer_stops: the grants, the checks, then the columns.
REVOKE UPDATE ("opens_at", "pickup_address", "dropoff_address", "dropoff_lat", "dropoff_lng", "trip_distance_metres", "delivery_version") ON TABLE "dispatch"."jobs" FROM "drive_app";
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
