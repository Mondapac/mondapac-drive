-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- What needs a dispatcher's hand outside the lifecycle (wave 2, handoff 21): dispatch ran out of
-- couriers ('dispatch-exhausted'), or a cold-chain reading was over the limit ('cold-chain-breach',
-- not recorded yet). Set without a new version; an assignment or a cancel clears it.
ALTER TABLE "delivery"."deliveries" ADD COLUMN "exception" VARCHAR(24);

ALTER TABLE "delivery"."deliveries"
  ADD CONSTRAINT "deliveries_exception_check"
  CHECK ("exception" IS NULL OR "exception" IN ('dispatch-exhausted', 'cold-chain-breach'));

GRANT UPDATE ("exception") ON TABLE "delivery"."deliveries" TO "drive_app";
