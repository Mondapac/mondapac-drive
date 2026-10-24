-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The delivery module's outbox and inbox (platform persistence design 5 and 6, copied from the
-- marketplace's identity module): a use case appends the events of a change in the same
-- transaction and the relay publishes them; a subscriber records each event it handled in the
-- inbox, so a redelivery does nothing. Status changes reach the marketplace's carrier integration
-- through the outbox.
CREATE TABLE "delivery"."outbox" (
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

CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "delivery"."outbox"("market_id", "aggregate_id", "aggregate_version");

ALTER TABLE "delivery"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^delivery\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay's claim (platform persistence design 6.1). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "delivery"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

CREATE TABLE "delivery"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

ALTER TABLE "delivery"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^delivery\.[a-z0-9-]+$');

-- The envelope is immutable to the application; the inbox is append-only until a prune job needs
-- DELETE.
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "delivery"."outbox" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "delivery"."inbox" TO "drive_app";
