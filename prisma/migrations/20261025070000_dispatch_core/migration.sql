-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The dispatch module (work package 07): one job per delivery, the offers sent to couriers in
-- waves, and the module's outbox and inbox (platform persistence design 5 and 6, as delivery's).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "dispatch";

-- CreateTable
CREATE TABLE "dispatch"."jobs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "service_area_code" VARCHAR(64) NOT NULL,
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lng" DOUBLE PRECISION NOT NULL,
    "minimum_vehicle" VARCHAR(16) NOT NULL,
    "weight_grams" INTEGER NOT NULL,
    "volume_litres" INTEGER NOT NULL,
    "temperature" VARCHAR(8) NOT NULL,
    "opens_at" TIMESTAMPTZ(6) NOT NULL,
    "round" INTEGER NOT NULL,
    "next_action_at" TIMESTAMPTZ(6),
    "assigned_courier_id" UUID,
    "assigned_vehicle" VARCHAR(16),
    "assignment_method" VARCHAR(8),
    "assigned_at" TIMESTAMPTZ(6),
    "excluded_courier_ids" UUID[],
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch"."offers" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "courier_id" UUID NOT NULL,
    "vehicle" VARCHAR(16) NOT NULL,
    "round" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "answered_at" TIMESTAMPTZ(6),

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "dispatch"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE INDEX "jobs_market_id_next_action_at_idx" ON "dispatch"."jobs"("market_id", "next_action_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_market_id_id_key" ON "dispatch"."jobs"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_market_id_delivery_id_key" ON "dispatch"."jobs"("market_id", "delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_market_id_job_id_sequence_key" ON "dispatch"."offers"("market_id", "job_id", "sequence");

-- CreateIndex
CREATE INDEX "offers_market_id_courier_id_status_idx" ON "dispatch"."offers"("market_id", "courier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offers_market_id_id_key" ON "dispatch"."offers"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "dispatch"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- AddForeignKey
ALTER TABLE "dispatch"."offers" ADD CONSTRAINT "offers_market_id_job_id_fkey" FOREIGN KEY ("market_id", "job_id") REFERENCES "dispatch"."jobs"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: value checks that mirror the domain.
ALTER TABLE "dispatch"."jobs"
  ADD CONSTRAINT "jobs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "jobs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "jobs_status_check" CHECK ("status" IN ('WAITING', 'OFFERING', 'ASSIGNED', 'EXHAUSTED', 'CANCELLED')),
  ADD CONSTRAINT "jobs_minimum_vehicle_check" CHECK ("minimum_vehicle" IN ('bicycle', 'motorbike', 'car', 'van')),
  ADD CONSTRAINT "jobs_temperature_check" CHECK ("temperature" IN ('ambient', 'chilled', 'frozen')),
  ADD CONSTRAINT "jobs_parcel_check" CHECK ("weight_grams" > 0 AND "volume_litres" > 0),
  ADD CONSTRAINT "jobs_pickup_check" CHECK ("pickup_lat" BETWEEN -90 AND 90 AND "pickup_lng" BETWEEN -180 AND 180),
  ADD CONSTRAINT "jobs_round_check" CHECK ("round" >= 0),
  ADD CONSTRAINT "jobs_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "jobs_assignment_check" CHECK (
    ("status" = 'ASSIGNED' AND "assigned_courier_id" IS NOT NULL AND "assigned_vehicle" IS NOT NULL
      AND "assignment_method" IN ('offer', 'manual') AND "assigned_at" IS NOT NULL)
    OR ("status" <> 'ASSIGNED' AND "assigned_courier_id" IS NULL AND "assigned_vehicle" IS NULL
      AND "assignment_method" IS NULL AND "assigned_at" IS NULL)
  );

ALTER TABLE "dispatch"."offers"
  ADD CONSTRAINT "offers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offers_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
  ADD CONSTRAINT "offers_vehicle_check" CHECK ("vehicle" IN ('bicycle', 'motorbike', 'car', 'van')),
  ADD CONSTRAINT "offers_round_check" CHECK ("round" >= 1),
  ADD CONSTRAINT "offers_sequence_check" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "offers_expiry_check" CHECK ("expires_at" > "sent_at"),
  ADD CONSTRAINT "offers_answer_check" CHECK (("status" = 'PENDING') = ("answered_at" IS NULL));

ALTER TABLE "dispatch"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^dispatch\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay's claim (platform persistence design 6.1). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "dispatch"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

ALTER TABLE "dispatch"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^dispatch\.[a-z0-9-]+$');

-- Grants (database-designer): a job keeps its delivery, requirements and opening time; an offer
-- keeps who, when and until when, and only its answer changes. The outbox envelope is immutable
-- and the inbox append-only.
GRANT USAGE ON SCHEMA "dispatch" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "dispatch"."jobs" TO "drive_app";
GRANT UPDATE ("status", "round", "next_action_at", "assigned_courier_id", "assigned_vehicle", "assignment_method", "assigned_at", "excluded_courier_ids", "version") ON TABLE "dispatch"."jobs" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "dispatch"."offers" TO "drive_app";
GRANT UPDATE ("status", "answered_at") ON TABLE "dispatch"."offers" TO "drive_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "dispatch"."outbox" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "dispatch"."inbox" TO "drive_app";
