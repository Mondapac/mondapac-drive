-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261026030000_fleet_capacity_idle_tax. Dropping tax_registered loses the GST flags
-- operators recorded (payouts then adds no GST): export the column before a production rollback.
REVOKE UPDATE ("max_weight_grams", "max_volume_litres") ON TABLE "fleet"."vehicles" FROM "drive_app";
REVOKE UPDATE ("idle_since", "tax_registered") ON TABLE "fleet"."couriers" FROM "drive_app";
DROP INDEX "fleet"."documents_market_id_file_key_key";
ALTER TABLE "fleet"."couriers" DROP CONSTRAINT "couriers_idle_since_check";
ALTER TABLE "fleet"."couriers" DROP COLUMN "tax_registered", DROP COLUMN "idle_since";
