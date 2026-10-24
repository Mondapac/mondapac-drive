-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "delivery";

-- CreateTable
CREATE TABLE "delivery"."deliveries" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "merchant_id" VARCHAR(64) NOT NULL,
    "external_reference" VARCHAR(128) NOT NULL,
    "service_area_code" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "pickup" JSONB NOT NULL,
    "dropoff" JSONB NOT NULL,
    "pickup_point" geography(Point, 4326) NOT NULL,
    "dropoff_point" geography(Point, 4326) NOT NULL,
    "weight_grams" INTEGER NOT NULL,
    "volume_litres" INTEGER NOT NULL,
    "temperature" VARCHAR(8) NOT NULL,
    "vehicle" VARCHAR(16) NOT NULL,
    "distance_metres" INTEGER NOT NULL,
    "quote" JSONB NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "courier_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery"."delivery_events" (
    "delivery_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "courier_id" VARCHAR(64),
    "vehicle" VARCHAR(16),
    "temperature_celsius" DECIMAL(4,1),
    "proof" JSONB,
    "reason" VARCHAR(500),
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("delivery_id","sequence")
);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_market_id_merchant_id_external_reference_key" ON "delivery"."deliveries"("market_id", "merchant_id", "external_reference");

-- CreateIndex
CREATE INDEX "deliveries_market_id_status_idx" ON "delivery"."deliveries"("market_id", "status");

-- Hand-written: spatial index for "deliveries near a courier" and dispatch zones.
CREATE INDEX "deliveries_pickup_point_idx" ON "delivery"."deliveries" USING GIST ("pickup_point");

-- AddForeignKey
ALTER TABLE "delivery"."delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "delivery"."deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: value checks that mirror the domain.
ALTER TABLE "delivery"."deliveries"
  ADD CONSTRAINT "deliveries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "deliveries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "deliveries_mode_check" CHECK ("mode" IN ('on_demand', 'scheduled')),
  ADD CONSTRAINT "deliveries_window_check" CHECK (
    ("mode" = 'scheduled' AND "window_start" IS NOT NULL AND "window_end" > "window_start")
    OR ("mode" = 'on_demand' AND "window_start" IS NULL AND "window_end" IS NULL)
  ),
  ADD CONSTRAINT "deliveries_temperature_check" CHECK ("temperature" IN ('ambient', 'chilled', 'frozen')),
  ADD CONSTRAINT "deliveries_amounts_check" CHECK ("total_amount" >= 0 AND "tax_amount" >= 0 AND "tax_amount" <= "total_amount"),
  ADD CONSTRAINT "deliveries_parcel_check" CHECK ("weight_grams" > 0 AND "volume_litres" > 0 AND "distance_metres" >= 0),
  ADD CONSTRAINT "deliveries_version_check" CHECK ("version" >= 1);

ALTER TABLE "delivery"."delivery_events"
  ADD CONSTRAINT "delivery_events_sequence_check" CHECK ("sequence" >= 1);
