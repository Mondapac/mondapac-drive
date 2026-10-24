-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261024170000_identity: the grants, then the tables with their CHECKs, indexes and
-- foreign keys (children first), then the schema.
REVOKE ALL ON ALL TABLES IN SCHEMA "identity" FROM "drive_app";
REVOKE USAGE ON SCHEMA "identity" FROM "drive_app";
DROP TABLE "identity"."invitations";
DROP TABLE "identity"."sign_in_challenges";
DROP TABLE "identity"."recovery_codes";
DROP TABLE "identity"."second_factors";
DROP TABLE "identity"."role_assignments";
DROP TABLE "identity"."role_permissions";
DROP TABLE "identity"."roles";
DROP TABLE "identity"."merchant_memberships";
DROP TABLE "identity"."sessions";
DROP TABLE "identity"."merchants";
DROP TABLE "identity"."inbox";
DROP TABLE "identity"."one_time_links";
DROP TABLE "identity"."sign_in_records";
DROP TABLE "identity"."sign_in_throttles";
DROP TABLE "identity"."password_credentials";
DROP TABLE "identity"."accounts";
DROP TABLE "identity"."outbox";
DROP SCHEMA "identity";
