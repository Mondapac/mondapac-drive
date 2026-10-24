-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The fleet module (work package 05): couriers of the hybrid fleet, their vehicles and their
-- documents, and the module's outbox. A courier references its identity account by id only; a
-- document keeps the object-store key of its file, never a document number (Privacy Act).
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fleet";

-- CreateTable
CREATE TABLE "fleet"."couriers" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_id" VARCHAR(64) NOT NULL,
    "employment_type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "service_area_code" VARCHAR(64) NOT NULL,
    "cold_chain_capable" BOOLEAN NOT NULL,
    "shift" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "couriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."vehicles" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "courier_id" UUID NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "plate" VARCHAR(10),
    "max_weight_grams" INTEGER NOT NULL,
    "max_volume_litres" INTEGER NOT NULL,
    "cold_box" VARCHAR(16) NOT NULL,
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."documents" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "courier_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "vehicle_id" UUID,
    "file_key" VARCHAR(255) NOT NULL,
    "media_type" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" VARCHAR(16),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."outbox" (
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

-- CreateIndex
CREATE INDEX "couriers_market_id_service_area_code_status_shift_idx" ON "fleet"."couriers"("market_id", "service_area_code", "status", "shift");

-- CreateIndex
CREATE UNIQUE INDEX "couriers_market_id_id_key" ON "fleet"."couriers"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "couriers_market_id_actor_id_key" ON "fleet"."couriers"("market_id", "actor_id");

-- CreateIndex
CREATE INDEX "vehicles_market_id_courier_id_idx" ON "fleet"."vehicles"("market_id", "courier_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_market_id_courier_id_id_key" ON "fleet"."vehicles"("market_id", "courier_id", "id");

-- CreateIndex
CREATE INDEX "documents_market_id_courier_id_idx" ON "fleet"."documents"("market_id", "courier_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "fleet"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- AddForeignKey
ALTER TABLE "fleet"."vehicles" ADD CONSTRAINT "vehicles_market_id_courier_id_fkey" FOREIGN KEY ("market_id", "courier_id") REFERENCES "fleet"."couriers"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fleet"."documents" ADD CONSTRAINT "documents_market_id_courier_id_fkey" FOREIGN KEY ("market_id", "courier_id") REFERENCES "fleet"."couriers"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A vehicle document names a vehicle of the same courier (security review L3).
ALTER TABLE "fleet"."documents" ADD CONSTRAINT "documents_market_id_courier_id_vehicle_id_fkey" FOREIGN KEY ("market_id", "courier_id", "vehicle_id") REFERENCES "fleet"."vehicles"("market_id", "courier_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- The codes the domain writes, so a row can never hold another value (database-designer).
ALTER TABLE "fleet"."couriers"
  ADD CONSTRAINT "couriers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "couriers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "couriers_employment_type_check" CHECK ("employment_type" IN ('employee', 'contractor')),
  ADD CONSTRAINT "couriers_status_check" CHECK ("status" IN ('applicant', 'active', 'suspended', 'offboarded')),
  ADD CONSTRAINT "couriers_shift_check" CHECK ("shift" IN ('offline', 'online', 'on_delivery', 'paused')),
  -- Only an active courier works a shift.
  ADD CONSTRAINT "couriers_shift_of_active_check" CHECK ("status" = 'active' OR "shift" = 'offline'),
  ADD CONSTRAINT "couriers_version_check" CHECK ("version" >= 1);

ALTER TABLE "fleet"."vehicles"
  ADD CONSTRAINT "vehicles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "vehicles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "vehicles_type_check" CHECK ("type" IN ('bicycle', 'motorbike', 'car', 'van')),
  ADD CONSTRAINT "vehicles_cold_box_check" CHECK ("cold_box" IN ('none', 'insulated', 'refrigerated')),
  ADD CONSTRAINT "vehicles_plate_check" CHECK ("plate" ~ '^[A-Z0-9]{1,10}$'),
  ADD CONSTRAINT "vehicles_capacity_check" CHECK ("max_weight_grams" > 0 AND "max_volume_litres" > 0);

ALTER TABLE "fleet"."documents"
  ADD CONSTRAINT "documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "documents_type_check" CHECK ("type" ~ '^[a-z][a-z0-9_]{1,39}$'),
  ADD CONSTRAINT "documents_media_type_check" CHECK ("media_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD CONSTRAINT "documents_status_check" CHECK ("status" IN ('submitted', 'verified', 'rejected', 'revoked')),
  -- A reviewed document has its review time; only a rejected or revoked one has a reason.
  ADD CONSTRAINT "documents_review_check" CHECK (
    ("status" = 'submitted') = ("reviewed_at" IS NULL)
    AND ("status" IN ('rejected', 'revoked')) = ("rejection_reason" IS NOT NULL)),
  -- The key the module builds: fleet/<market>/<courier>/<document>.
  ADD CONSTRAINT "documents_file_key_check" CHECK ("file_key" ~ '^fleet/[A-Za-z0-9_-]+/[0-9a-f-]{36}/[0-9a-f-]{36}$');

ALTER TABLE "fleet"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^fleet\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay's claim (platform persistence design 6.1). Invisible to Prisma.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "fleet"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants (database-designer): rows are never deleted. A courier changes only its standing,
-- shift, version and the terms an operator confirms on approval; a vehicle only its active
-- flag; a document only its review and the expiry the operator confirms. The outbox envelope
-- is immutable to the application.
GRANT USAGE ON SCHEMA "fleet" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "fleet"."couriers" TO "drive_app";
GRANT UPDATE ("status", "shift", "version", "employment_type", "cold_chain_capable") ON TABLE "fleet"."couriers" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "fleet"."vehicles" TO "drive_app";
GRANT UPDATE ("active") ON TABLE "fleet"."vehicles" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "fleet"."documents" TO "drive_app";
GRANT UPDATE ("status", "expires_at", "reviewed_at", "rejection_reason") ON TABLE "fleet"."documents" TO "drive_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "fleet"."outbox" TO "drive_app";
