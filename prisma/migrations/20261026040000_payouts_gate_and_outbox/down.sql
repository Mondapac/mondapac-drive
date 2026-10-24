-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026040000_payouts_gate_and_outbox: the grants, then the outbox and inbox with
-- their CHECKs and indexes, then the account column.
REVOKE UPDATE ("hold_reason") ON TABLE "payouts"."payout_lines" FROM "drive_app";
REVOKE UPDATE ("provider_state_at") ON TABLE "payouts"."payout_accounts" FROM "drive_app";
REVOKE SELECT, INSERT ON TABLE "payouts"."inbox" FROM "drive_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "payouts"."outbox" FROM "drive_app";
DROP TABLE "payouts"."inbox";
DROP TABLE "payouts"."outbox";
ALTER TABLE "payouts"."payout_accounts" DROP COLUMN "provider_state_at";
