-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025100000_payouts_ledger: the grants, then the tables with their CHECKs and
-- indexes, then the schema.
REVOKE ALL ON TABLE "payouts"."provider_events" FROM "drive_app";
REVOKE ALL ON TABLE "payouts"."payout_accounts" FROM "drive_app";
REVOKE ALL ON TABLE "payouts"."payout_lines" FROM "drive_app";
REVOKE ALL ON TABLE "payouts"."payout_runs" FROM "drive_app";
REVOKE ALL ON TABLE "payouts"."courier_deliveries" FROM "drive_app";
REVOKE ALL ON TABLE "payouts"."ledger_entries" FROM "drive_app";
REVOKE USAGE ON SCHEMA "payouts" FROM "drive_app";
DROP TABLE "payouts"."provider_events";
DROP TABLE "payouts"."payout_accounts";
DROP TABLE "payouts"."payout_lines";
DROP TABLE "payouts"."payout_runs";
DROP TABLE "payouts"."courier_deliveries";
DROP TABLE "payouts"."ledger_entries";
DROP SCHEMA "payouts";
