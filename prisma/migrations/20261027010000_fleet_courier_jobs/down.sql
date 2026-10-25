-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027010000_fleet_courier_jobs. Fails while a job is open or a subscriber has
-- handled an event, which is right: data is never dropped by a down migration.
DO $refuse$
BEGIN
  IF EXISTS (SELECT FROM "fleet"."inbox") OR EXISTS (SELECT FROM "fleet"."courier_jobs") THEN
    RAISE EXCEPTION 'fleet holds courier job data; the down migration does not drop it';
  END IF;
END
$refuse$;

REVOKE SELECT, INSERT ON TABLE "fleet"."inbox" FROM "drive_app";
REVOKE UPDATE ("courier_account_id", "assigned_at", "ended", "delivery_version") ON TABLE "fleet"."courier_jobs" FROM "drive_app";
REVOKE SELECT, INSERT ON TABLE "fleet"."courier_jobs" FROM "drive_app";
DROP TABLE "fleet"."inbox";
DROP TABLE "fleet"."courier_jobs";
