-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Fleet, wave 2 (handoff 23): when each courier last went online from offline or from a delivery
-- (dispatch offers work first to whoever has waited longest), whether an operator recorded the
-- courier as registered for the Market's sales tax (payouts), and a unique key per stored file
-- (the sweep of files no document names). A vehicle's capacity columns already exist: the rate
-- card's default is applied by the module when a vehicle is added, and an operator may now
-- override it.
ALTER TABLE "fleet"."couriers"
  ADD COLUMN "idle_since" TIMESTAMPTZ(6),
  ADD COLUMN "tax_registered" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows take false above; new rows always state it (no database default, like tenant_id).
ALTER TABLE "fleet"."couriers" ALTER COLUMN "tax_registered" DROP DEFAULT;

-- A courier who works no shift has nothing to wait for: offline couriers may keep the last value,
-- but a never-online courier has none, and an online one always has one.
ALTER TABLE "fleet"."couriers"
  ADD CONSTRAINT "couriers_idle_since_check" CHECK ("shift" <> 'online' OR "idle_since" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "documents_market_id_file_key_key" ON "fleet"."documents"("market_id", "file_key");

GRANT UPDATE ("idle_since", "tax_registered") ON TABLE "fleet"."couriers" TO "drive_app";
-- An operator overrides a vehicle's capacity (the rate card's default) with its own measure.
GRANT UPDATE ("max_weight_grams", "max_volume_litres") ON TABLE "fleet"."vehicles" TO "drive_app";
