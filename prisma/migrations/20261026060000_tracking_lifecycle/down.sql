-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026060000_tracking_lifecycle. Fails while a subscriber has handled an event,
-- which is right: data is never dropped by a down migration.
DO $refuse$
BEGIN
  IF EXISTS (SELECT FROM "tracking"."inbox")
     OR EXISTS (SELECT FROM "tracking"."tracked_deliveries" WHERE "delivery_version" IS NOT NULL) THEN
    RAISE EXCEPTION 'tracking holds lifecycle data; the down migration does not drop it';
  END IF;
END
$refuse$;

REVOKE SELECT, INSERT ON TABLE "tracking"."inbox" FROM "drive_app";
DROP TABLE "tracking"."inbox";
REVOKE UPDATE ("delivery_version") ON TABLE "tracking"."tracked_deliveries" FROM "drive_app";
ALTER TABLE "tracking"."tracked_deliveries" DROP CONSTRAINT "tracked_deliveries_delivery_version_check";
ALTER TABLE "tracking"."tracked_deliveries" DROP COLUMN "delivery_version";
