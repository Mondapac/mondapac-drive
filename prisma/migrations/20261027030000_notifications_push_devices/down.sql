-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027030000_notifications_push_devices: the grants, then the table.
REVOKE ALL ON TABLE "notifications"."push_devices" FROM "drive_app";
DROP TABLE "notifications"."push_devices";
