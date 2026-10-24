-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026050000_notifications_wiring: the grants, the inbox, then the column.
REVOKE UPDATE ("event_types", "previous_secret_valid_until") ON TABLE "notifications"."webhook_subscriptions" FROM "drive_app";
REVOKE ALL ON TABLE "notifications"."inbox" FROM "drive_app";
DROP TABLE "notifications"."inbox";
ALTER TABLE "notifications"."webhook_subscriptions" DROP COLUMN "previous_secret_valid_until";
