-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The payouts module (Phase 1 slice 9, part 1): the couriers' append-only earnings ledger, the
-- record of every delivered delivery, payout runs and their lines, the couriers' connected
-- accounts at the payment provider (ids only) and the provider webhook events already handled.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payouts";

-- CreateTable
CREATE TABLE "payouts"."ledger_entries" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference" VARCHAR(160) NOT NULL,
    "delivery_id" VARCHAR(64),
    "payout_line_id" UUID,
    "reverses_entry_id" UUID,
    "reason" VARCHAR(32),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts"."courier_deliveries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" VARCHAR(64) NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "engagement" VARCHAR(16) NOT NULL,
    "vehicle" VARCHAR(16) NOT NULL,
    "temperature" VARCHAR(8) NOT NULL,
    "distance_metres" INTEGER NOT NULL,
    "paid_waiting_minutes" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "earning_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "courier_deliveries_pkey" PRIMARY KEY ("market_id","delivery_id")
);

-- CreateTable
CREATE TABLE "payouts"."payout_runs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cutoff" TIMESTAMPTZ(6) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts"."payout_lines" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "hold_reason" VARCHAR(32),
    "destination" VARCHAR(64),
    "transfer_id" VARCHAR(64),
    "attempts" INTEGER NOT NULL,
    "last_error_code" VARCHAR(64),
    "reversed_amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts"."payout_accounts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "courier_id" VARCHAR(64) NOT NULL,
    "provider_account_id" VARCHAR(64) NOT NULL,
    "payouts_enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("market_id","courier_id")
);

-- CreateTable
CREATE TABLE "payouts"."provider_events" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("market_id","event_id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_courier_id_occurred_at_idx" ON "payouts"."ledger_entries"("market_id", "courier_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_delivery_id_idx" ON "payouts"."ledger_entries"("market_id", "delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_market_id_reference_key" ON "payouts"."ledger_entries"("market_id", "reference");

-- CreateIndex
CREATE INDEX "courier_deliveries_market_id_courier_id_delivered_at_idx" ON "payouts"."courier_deliveries"("market_id", "courier_id", "delivered_at");

-- CreateIndex
CREATE UNIQUE INDEX "payout_runs_market_id_id_key" ON "payouts"."payout_runs"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_runs_market_id_cutoff_key" ON "payouts"."payout_runs"("market_id", "cutoff");

-- CreateIndex
CREATE INDEX "payout_lines_market_id_status_created_at_idx" ON "payouts"."payout_lines"("market_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payout_lines_market_id_run_id_courier_id_key" ON "payouts"."payout_lines"("market_id", "run_id", "courier_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_lines_market_id_transfer_id_key" ON "payouts"."payout_lines"("market_id", "transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_market_id_provider_account_id_key" ON "payouts"."payout_accounts"("market_id", "provider_account_id");

-- AddForeignKey
ALTER TABLE "payouts"."payout_lines" ADD CONSTRAINT "payout_lines_market_id_run_id_fkey" FOREIGN KEY ("market_id", "run_id") REFERENCES "payouts"."payout_runs"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: value checks that mirror the domain.
ALTER TABLE "payouts"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "ledger_entries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "ledger_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN ('earning', 'tip', 'adjustment', 'reversal', 'payout')),
  -- Earnings and tips credit, payouts debit, an adjustment is never zero; the tax has the sign
  -- of its amount.
  ADD CONSTRAINT "ledger_entries_sign_check" CHECK (
    ("kind" IN ('earning', 'tip') AND "amount" > 0)
    OR ("kind" = 'payout' AND "amount" + "tax_amount" < 0)
    OR ("kind" = 'adjustment' AND "amount" <> 0)
    OR "kind" = 'reversal'
  ),
  ADD CONSTRAINT "ledger_entries_tax_sign_check" CHECK ("tax_amount" = 0 OR sign("tax_amount") = sign("amount")),
  ADD CONSTRAINT "ledger_entries_links_check" CHECK (
    ("kind" IN ('earning', 'tip') AND "delivery_id" IS NOT NULL)
    OR ("kind" = 'payout' AND "payout_line_id" IS NOT NULL)
    OR ("kind" = 'reversal' AND "reverses_entry_id" IS NOT NULL)
    OR "kind" = 'adjustment'
  );

ALTER TABLE "payouts"."courier_deliveries"
  ADD CONSTRAINT "courier_deliveries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "courier_deliveries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "courier_deliveries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "courier_deliveries_engagement_check" CHECK ("engagement" IN ('employee', 'contractor')),
  ADD CONSTRAINT "courier_deliveries_vehicle_check" CHECK ("vehicle" IN ('bicycle', 'motorbike', 'car', 'van')),
  ADD CONSTRAINT "courier_deliveries_temperature_check" CHECK ("temperature" IN ('ambient', 'chilled', 'frozen')),
  ADD CONSTRAINT "courier_deliveries_values_check" CHECK (
    "distance_metres" >= 0 AND "paid_waiting_minutes" >= 0 AND "earning_amount" >= 0
    AND ("engagement" = 'contractor' OR "earning_amount" = 0)
  ),
  ADD CONSTRAINT "courier_deliveries_breakdown_check" CHECK (jsonb_typeof("breakdown") = 'object');

ALTER TABLE "payouts"."payout_runs"
  ADD CONSTRAINT "payout_runs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_runs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_runs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payout_runs_total_check" CHECK ("total_amount" >= 0);

ALTER TABLE "payouts"."payout_lines"
  ADD CONSTRAINT "payout_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_lines_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payout_lines_status_check" CHECK ("status" IN ('pending', 'held', 'transferred', 'failed', 'unresolved', 'reversed')),
  ADD CONSTRAINT "payout_lines_hold_check" CHECK (("status" = 'held') = ("hold_reason" IS NOT NULL)),
  ADD CONSTRAINT "payout_lines_destination_check" CHECK ("status" = 'held' OR "destination" IS NOT NULL),
  ADD CONSTRAINT "payout_lines_transfer_check" CHECK ("status" NOT IN ('transferred', 'reversed') OR "transfer_id" IS NOT NULL),
  ADD CONSTRAINT "payout_lines_amounts_check" CHECK (
    "amount" + "tax_amount" > 0 AND "reversed_amount" >= 0
    AND "reversed_amount" <= "amount" + "tax_amount"
  ),
  ADD CONSTRAINT "payout_lines_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "payout_lines_version_check" CHECK ("version" >= 1);

ALTER TABLE "payouts"."payout_accounts"
  ADD CONSTRAINT "payout_accounts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_accounts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_accounts_provider_account_id_check" CHECK ("provider_account_id" ~ '^[A-Za-z0-9_]{1,64}$');

ALTER TABLE "payouts"."provider_events"
  ADD CONSTRAINT "provider_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "provider_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- The application role: the ledger, the delivery records, the runs and the handled events are
-- append-only; a line changes only its transfer state; an account only whether it can be paid.
GRANT USAGE ON SCHEMA "payouts" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."ledger_entries" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."courier_deliveries" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."payout_runs" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."payout_lines" TO "drive_app";
GRANT UPDATE ("status", "transfer_id", "attempts", "last_error_code", "reversed_amount", "updated_at", "version") ON TABLE "payouts"."payout_lines" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."payout_accounts" TO "drive_app";
GRANT UPDATE ("payouts_enabled", "updated_at") ON TABLE "payouts"."payout_accounts" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "payouts"."provider_events" TO "drive_app";
