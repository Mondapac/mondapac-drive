-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025070000_dispatch_core: the grants, then the tables with their CHECKs and
-- indexes, then the schema.
REVOKE SELECT, INSERT ON TABLE "dispatch"."inbox" FROM "drive_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "dispatch"."outbox" FROM "drive_app";
REVOKE SELECT, INSERT, UPDATE ("status", "answered_at") ON TABLE "dispatch"."offers" FROM "drive_app";
REVOKE SELECT, INSERT, UPDATE ("status", "round", "next_action_at", "assigned_courier_id", "assigned_vehicle", "assignment_method", "assigned_at", "excluded_courier_ids", "version") ON TABLE "dispatch"."jobs" FROM "drive_app";
REVOKE USAGE ON SCHEMA "dispatch" FROM "drive_app";
DROP TABLE "dispatch"."inbox";
DROP TABLE "dispatch"."outbox";
DROP TABLE "dispatch"."offers";
DROP TABLE "dispatch"."jobs";
DROP SCHEMA "dispatch";
