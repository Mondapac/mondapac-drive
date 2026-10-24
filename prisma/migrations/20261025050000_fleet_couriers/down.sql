-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025050000_fleet_couriers: the grants, then the tables with their CHECKs and
-- indexes, then the schema.
REVOKE ALL ON TABLE "fleet"."outbox", "fleet"."documents", "fleet"."vehicles", "fleet"."couriers" FROM "drive_app";
REVOKE USAGE ON SCHEMA "fleet" FROM "drive_app";
DROP TABLE "fleet"."outbox";
DROP TABLE "fleet"."documents";
DROP TABLE "fleet"."vehicles";
DROP TABLE "fleet"."couriers";
DROP SCHEMA "fleet";
