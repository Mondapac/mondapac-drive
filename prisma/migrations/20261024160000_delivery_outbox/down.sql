-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261024160000_delivery_outbox: the grants, then the tables with their CHECKs and
-- indexes.
REVOKE SELECT, INSERT ON TABLE "delivery"."inbox" FROM "drive_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "delivery"."outbox" FROM "drive_app";
DROP TABLE "delivery"."inbox";
DROP TABLE "delivery"."outbox";
