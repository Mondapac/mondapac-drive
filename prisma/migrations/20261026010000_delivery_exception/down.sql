SET lock_timeout = '5s';

REVOKE UPDATE ("exception") ON TABLE "delivery"."deliveries" FROM "drive_app";

ALTER TABLE "delivery"."deliveries" DROP CONSTRAINT "deliveries_exception_check";
ALTER TABLE "delivery"."deliveries" DROP COLUMN "exception";
