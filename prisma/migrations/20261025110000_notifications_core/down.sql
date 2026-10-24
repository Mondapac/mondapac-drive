-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025110000_notifications_core: the grants, then the tables with their CHECKs and
-- indexes, then the schema.
REVOKE ALL ON TABLE "notifications"."sms_messages" FROM "drive_app";
REVOKE ALL ON TABLE "notifications"."webhook_calls" FROM "drive_app";
REVOKE ALL ON TABLE "notifications"."webhook_subscriptions" FROM "drive_app";
REVOKE USAGE ON SCHEMA "notifications" FROM "drive_app";
DROP TABLE "notifications"."sms_messages";
DROP TABLE "notifications"."webhook_calls";
DROP TABLE "notifications"."webhook_subscriptions";
DROP SCHEMA "notifications";
