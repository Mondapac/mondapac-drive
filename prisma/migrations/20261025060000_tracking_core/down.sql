-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025060000_tracking_core: the grants, then the tables and the schema. Fails while
-- tracking data is stored, which is right: data is never dropped by a down migration.
REVOKE SELECT, INSERT, DELETE ON TABLE "tracking"."links" FROM "drive_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "tracking"."breadcrumbs" FROM "drive_app";
REVOKE UPDATE ("status", "courier_id", "vehicle", "updated_at", "ended_at", "version")
  ON TABLE "tracking"."tracked_deliveries" FROM "drive_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "tracking"."tracked_deliveries" FROM "drive_app";
REVOKE USAGE ON SCHEMA "tracking" FROM "drive_app";

DO $refuse$
BEGIN
  IF EXISTS (SELECT FROM "tracking"."tracked_deliveries")
     OR EXISTS (SELECT FROM "tracking"."breadcrumbs")
     OR EXISTS (SELECT FROM "tracking"."links") THEN
    RAISE EXCEPTION 'tracking holds data; the down migration does not drop it';
  END IF;
END
$refuse$;

DROP TABLE "tracking"."links";
DROP TABLE "tracking"."breadcrumbs";
DROP TABLE "tracking"."tracked_deliveries";
DROP SCHEMA "tracking";
