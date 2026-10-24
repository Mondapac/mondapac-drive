SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "delivery"."proof_photos" FROM "drive_app";
REVOKE UPDATE ("wrong_pins") ON TABLE "delivery"."deliveries" FROM "drive_app";

DROP TABLE "delivery"."proof_photos";

ALTER TABLE "delivery"."deliveries" DROP CONSTRAINT "deliveries_wrong_pins_check";
ALTER TABLE "delivery"."deliveries" DROP COLUMN "wrong_pins";
