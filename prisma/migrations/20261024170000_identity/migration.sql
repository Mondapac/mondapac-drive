-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The identity module (work package 2), copied from the marketplace's identity migrations
-- (Mondapac/mondapac-marketplace-platform at a87dd54f, 20261007120000 to 20261017140000) as one
-- migration and cut to Drive's populations: admin (operators and dispatchers, cookie sessions),
-- courier (the app's bearer sessions) and merchant (API keys: sessions with transport api-key on
-- the merchant's integration account). No seller, customer, step-up or social sign-in table.

CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateTable
CREATE TABLE "identity"."outbox" (
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
CREATE TABLE "identity"."accounts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "population" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "timezone" VARCHAR(64),
    "locale" VARCHAR(16),
    "status" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "signed_up_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."password_credentials" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateTable
CREATE TABLE "identity"."sessions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "population" TEXT NOT NULL,
    "merchant_id" UUID,
    "token_hash" BYTEA NOT NULL,
    "transport" TEXT NOT NULL,
    "device" VARCHAR(32),
    "label" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_timeout_seconds" INTEGER NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_throttles" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "account_key" BYTEA,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "blocked_until" TIMESTAMPTZ(6),

    CONSTRAINT "sign_in_throttles_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_records" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "population" TEXT NOT NULL,
    "account_id" UUID,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "origin" INET NOT NULL,
    "session_id" UUID,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "sign_in_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."one_time_links" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "token_hash" BYTEA,
    "issued_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "one_time_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "identity"."merchants" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."merchant_memberships" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."roles" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seed_code" TEXT,
    "seed_version" INTEGER,
    "name" TEXT,
    "name_normalized" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_permissions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("market_id","role_id","permission_key")
);

-- CreateTable
CREATE TABLE "identity"."role_assignments" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by_account_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."second_factors" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "pending_secret_ciphertext" TEXT,
    "last_accepted_step" INTEGER,
    "activated_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "second_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."recovery_codes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "second_factor_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("market_id","second_factor_id","position")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_challenges" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" SMALLINT NOT NULL,
    "credential_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sign_in_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."invitations" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT,
    "email_normalized" TEXT,
    "role_id" UUID NOT NULL,
    "invited_by_account_id" UUID,
    "token_hash" BYTEA,
    "expires_at" TIMESTAMPTZ(6),
    "state" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "accepted_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "identity"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_market_id_population_email_normalized_key" ON "identity"."accounts"("market_id", "population", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_market_id_id_key" ON "identity"."accounts"("market_id", "id");

-- CreateIndex
CREATE INDEX "sessions_market_id_account_id_idx" ON "identity"."sessions"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "sessions_market_id_absolute_expires_at_idx" ON "identity"."sessions"("market_id", "absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_market_id_id_key" ON "identity"."sessions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_market_id_token_hash_key" ON "identity"."sessions"("market_id", "token_hash");

-- CreateIndex
CREATE INDEX "sign_in_throttles_market_id_account_key_idx" ON "identity"."sign_in_throttles"("market_id", "account_key");

-- CreateIndex
CREATE INDEX "sign_in_records_market_id_occurred_at_idx" ON "identity"."sign_in_records"("market_id", "occurred_at");

-- CreateIndex
CREATE INDEX "sign_in_records_market_id_account_id_occurred_at_idx" ON "identity"."sign_in_records"("market_id", "account_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_links_market_id_account_id_purpose_key" ON "identity"."one_time_links"("market_id", "account_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_links_market_id_token_hash_key" ON "identity"."one_time_links"("market_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_market_id_id_key" ON "identity"."merchants"("market_id", "id");

-- CreateIndex
CREATE INDEX "merchant_memberships_market_id_account_id_idx" ON "identity"."merchant_memberships"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "merchant_memberships_market_id_merchant_id_state_idx" ON "identity"."merchant_memberships"("market_id", "merchant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "roles_market_id_id_key" ON "identity"."roles"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_market_id_scope_seed_code_key" ON "identity"."roles"("market_id", "scope", "seed_code");

-- CreateIndex
CREATE INDEX "role_assignments_market_id_role_id_idx" ON "identity"."role_assignments"("market_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_market_id_account_id_key" ON "identity"."role_assignments"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "second_factors_market_id_account_id_key" ON "identity"."second_factors"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "second_factors_market_id_id_key" ON "identity"."second_factors"("market_id", "id");

-- CreateIndex
CREATE INDEX "sign_in_challenges_market_id_account_id_idx" ON "identity"."sign_in_challenges"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_challenges_market_id_token_hash_key" ON "identity"."sign_in_challenges"("market_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_market_id_token_hash_key" ON "identity"."invitations"("market_id", "token_hash");

-- AddForeignKey
ALTER TABLE "identity"."password_credentials" ADD CONSTRAINT "password_credentials_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_market_id_merchant_id_fkey" FOREIGN KEY ("market_id", "merchant_id") REFERENCES "identity"."merchants"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."one_time_links" ADD CONSTRAINT "one_time_links_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."merchant_memberships" ADD CONSTRAINT "merchant_memberships_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."merchant_memberships" ADD CONSTRAINT "merchant_memberships_market_id_merchant_id_fkey" FOREIGN KEY ("market_id", "merchant_id") REFERENCES "identity"."merchants"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_market_id_role_id_fkey" FOREIGN KEY ("market_id", "role_id") REFERENCES "identity"."roles"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_market_id_role_id_fkey" FOREIGN KEY ("market_id", "role_id") REFERENCES "identity"."roles"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."second_factors" ADD CONSTRAINT "second_factors_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."recovery_codes" ADD CONSTRAINT "recovery_codes_market_id_second_factor_id_fkey" FOREIGN KEY ("market_id", "second_factor_id") REFERENCES "identity"."second_factors"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."sign_in_challenges" ADD CONSTRAINT "sign_in_challenges_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written CHECKs (Prisma cannot express them). Codes are the domain's closed lists.
ALTER TABLE "identity"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^identity\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "accounts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "accounts_population_check" CHECK ("population" IN ('admin', 'merchant', 'courier')),
  ADD CONSTRAINT "accounts_email_check" CHECK (char_length("email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "accounts_email_normalized_check" CHECK (
    "email_normalized" = lower("email_normalized" COLLATE "C")
    AND "email_normalized" = btrim("email_normalized")
    AND "email_normalized" IS NFC NORMALIZED
    AND char_length("email_normalized") BETWEEN 3 AND 254
    AND position('@' in "email_normalized") > 1),
  ADD CONSTRAINT "accounts_display_name_check" CHECK (
    char_length("display_name") BETWEEN 1 AND 100
    AND "display_name" = btrim("display_name")
    AND "display_name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "accounts_status_check" CHECK ("status" IN ('active', 'disabled')),
  ADD CONSTRAINT "accounts_signed_up_at_check" CHECK ("signed_up_at" >= "created_at"),
  ADD CONSTRAINT "accounts_timezone_check" CHECK ("timezone" IS NULL OR char_length("timezone") BETWEEN 1 AND 64),
  ADD CONSTRAINT "accounts_locale_check" CHECK ("locale" IS NULL OR char_length("locale") BETWEEN 2 AND 16),
  ADD CONSTRAINT "accounts_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."password_credentials"
  ADD CONSTRAINT "password_credentials_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "password_credentials_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "password_credentials_password_hash_check" CHECK (
    "password_hash" ~ '^\$[a-z0-9-]+\$' AND char_length("password_hash") <= 255);

-- A session's population fixes its transport: an admin's browser holds a cookie, a courier's
-- app a bearer token, a merchant an API key. Only a merchant session names its merchant, and
-- only an API key has a label.
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sessions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sessions_population_check" CHECK ("population" IN ('admin', 'merchant', 'courier')),
  ADD CONSTRAINT "sessions_transport_check" CHECK ("transport" IN ('cookie', 'bearer', 'api-key')),
  ADD CONSTRAINT "sessions_population_transport_check" CHECK (
    ("population" = 'admin' AND "transport" = 'cookie')
    OR ("population" = 'courier' AND "transport" = 'bearer')
    OR ("population" = 'merchant' AND "transport" = 'api-key')),
  ADD CONSTRAINT "sessions_merchant_id_check" CHECK (("population" = 'merchant') = ("merchant_id" IS NOT NULL)),
  ADD CONSTRAINT "sessions_label_check" CHECK (
    ("transport" = 'api-key') = ("label" IS NOT NULL)
    AND ("label" IS NULL OR (char_length("label") BETWEEN 1 AND 64 AND "label" = btrim("label")))),
  ADD CONSTRAINT "sessions_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "sessions_device_check" CHECK ("device" IS NULL OR "device" ~ '^[a-z]+\.[a-z]+$'),
  ADD CONSTRAINT "sessions_idle_timeout_seconds_check" CHECK ("idle_timeout_seconds" > 0),
  ADD CONSTRAINT "sessions_absolute_expires_at_check" CHECK ("absolute_expires_at" > "created_at"),
  ADD CONSTRAINT "sessions_revoked_reason_check" CHECK (
    "revoked_reason" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("revoked_reason") <= 64),
  ADD CONSTRAINT "sessions_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));

-- A merchant's API keys, listed and revoked together on suspension. Invisible to Prisma.
CREATE INDEX "sessions_market_id_merchant_id_idx" ON "identity"."sessions" ("market_id", "merchant_id") WHERE "merchant_id" IS NOT NULL;

ALTER TABLE "identity"."sign_in_throttles"
  ADD CONSTRAINT "sign_in_throttles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_throttles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_throttles_kind_check" CHECK ("kind" IN (
    'sign-in.account-origin', 'sign-in.account', 'sign-in.origin',
    'second-factor.account', 'mail.account', 'mail.origin', 'sign-out-others.account')),
  ADD CONSTRAINT "sign_in_throttles_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "sign_in_throttles_account_key_check" CHECK (
    ("account_key" IS NULL) = ("kind" IN ('sign-in.origin', 'mail.origin'))
    AND ("account_key" IS NULL OR octet_length("account_key") = 32)),
  ADD CONSTRAINT "sign_in_throttles_attempts_check" CHECK ("attempts" >= 0);

ALTER TABLE "identity"."sign_in_records"
  ADD CONSTRAINT "sign_in_records_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_records_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_records_population_check" CHECK ("population" IN ('admin', 'merchant', 'courier')),
  ADD CONSTRAINT "sign_in_records_outcome_check" CHECK (
    "outcome" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("outcome") <= 64),
  ADD CONSTRAINT "sign_in_records_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "one_time_links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN ('reset-password', 'enrol-second-factor')),
  ADD CONSTRAINT "one_time_links_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "one_time_links_issued_check" CHECK (("token_hash" IS NULL) = ("issued_at" IS NULL)),
  ADD CONSTRAINT "one_time_links_expires_check" CHECK (("issued_at" IS NULL) = ("expires_at" IS NULL)),
  ADD CONSTRAINT "one_time_links_expires_at_check" CHECK ("expires_at" > "issued_at"),
  ADD CONSTRAINT "one_time_links_consumed_check" CHECK ("consumed_at" IS NULL OR "issued_at" IS NOT NULL),
  ADD CONSTRAINT "one_time_links_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^identity\.[a-z0-9-]+$');

ALTER TABLE "identity"."merchants"
  ADD CONSTRAINT "merchants_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "merchants_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "merchants_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 100
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "merchants_state_check" CHECK ("state" IN ('active', 'suspended')),
  ADD CONSTRAINT "merchants_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."merchant_memberships"
  ADD CONSTRAINT "merchant_memberships_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "merchant_memberships_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "merchant_memberships_state_check" CHECK ("state" IN ('active', 'removed')),
  ADD CONSTRAINT "merchant_memberships_removed_at_check" CHECK (("state" = 'removed') = ("removed_at" IS NOT NULL)),
  ADD CONSTRAINT "merchant_memberships_version_check" CHECK ("version" >= 1);

-- One active membership per account. Invisible to Prisma.
CREATE UNIQUE INDEX "merchant_memberships_market_id_account_id_active_key" ON "identity"."merchant_memberships" ("market_id", "account_id") WHERE "state" = 'active';

ALTER TABLE "identity"."roles"
  ADD CONSTRAINT "roles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "roles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "roles_scope_check" CHECK ("scope" IN ('platform', 'merchant', 'courier')),
  ADD CONSTRAINT "roles_kind_check" CHECK ("kind" IN ('system', 'default', 'custom')),
  -- Default and custom roles exist only in the platform scope: a merchant or a courier holds
  -- its scope's system role.
  ADD CONSTRAINT "roles_kind_scope_check" CHECK ("kind" = 'system' OR "scope" = 'platform'),
  ADD CONSTRAINT "roles_seed_check" CHECK (
    ("seed_code" IS NOT NULL) = ("kind" <> 'custom')
    AND ("seed_version" IS NOT NULL) = ("kind" <> 'custom')),
  ADD CONSTRAINT "roles_seed_code_check" CHECK (
    "seed_code" ~ '^[a-z][a-z0-9-]*$' AND char_length("seed_code") <= 64),
  ADD CONSTRAINT "roles_seed_version_check" CHECK ("seed_version" >= 1),
  ADD CONSTRAINT "roles_name_required_check" CHECK (
    ("name" IS NOT NULL) = ("kind" = 'custom')
    AND ("name_normalized" IS NOT NULL) = ("name" IS NOT NULL)),
  ADD CONSTRAINT "roles_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 80
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "roles_name_normalized_check" CHECK (
    "name_normalized" = lower("name_normalized" COLLATE "C")
    AND "name_normalized" = btrim("name_normalized")
    AND "name_normalized" IS NFC NORMALIZED
    AND char_length("name_normalized") BETWEEN 1 AND 80),
  ADD CONSTRAINT "roles_version_check" CHECK ("version" >= 1);

-- One system role per scope and Market; custom role names unique in the Market's platform
-- scope (M10). Invisible to Prisma.
CREATE UNIQUE INDEX "roles_market_id_scope_system_key" ON "identity"."roles" ("market_id", "scope") WHERE "kind" = 'system';
CREATE UNIQUE INDEX "roles_market_id_name_platform_custom_key" ON "identity"."roles" ("market_id", "name_normalized") WHERE "kind" = 'custom' AND "scope" = 'platform';

ALTER TABLE "identity"."role_permissions"
  ADD CONSTRAINT "role_permissions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "role_permissions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "role_permissions_permission_key_check" CHECK (
    "permission_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$'
    AND char_length("permission_key") <= 128);

ALTER TABLE "identity"."role_assignments"
  ADD CONSTRAINT "role_assignments_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "role_assignments_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "role_assignments_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."second_factors"
  ADD CONSTRAINT "second_factors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "second_factors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "second_factors_state_check" CHECK ("state" IN ('pending', 'active')),
  ADD CONSTRAINT "second_factors_activated_check" CHECK (("state" = 'active') = ("activated_at" IS NOT NULL)),
  ADD CONSTRAINT "second_factors_pending_secret_check" CHECK ("pending_secret_ciphertext" IS NULL OR "state" = 'active'),
  ADD CONSTRAINT "second_factors_last_accepted_step_check" CHECK ("last_accepted_step" >= 0),
  ADD CONSTRAINT "second_factors_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."recovery_codes"
  ADD CONSTRAINT "recovery_codes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "recovery_codes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "recovery_codes_position_check" CHECK ("position" BETWEEN 1 AND 10),
  ADD CONSTRAINT "recovery_codes_code_hash_check" CHECK (octet_length("code_hash") = 32);

ALTER TABLE "identity"."sign_in_challenges"
  ADD CONSTRAINT "sign_in_challenges_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_challenges_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_challenges_purpose_check" CHECK ("purpose" IN ('second-factor', 'second-factor-enrolment')),
  ADD CONSTRAINT "sign_in_challenges_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "sign_in_challenges_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "sign_in_challenges_expires_at_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "identity"."invitations"
  ADD CONSTRAINT "invitations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "invitations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "invitations_kind_check" CHECK ("kind" IN ('admin', 'courier')),
  ADD CONSTRAINT "invitations_state_check" CHECK ("state" IN ('pending', 'accepted', 'revoked')),
  ADD CONSTRAINT "invitations_email_pending_check" CHECK (
    ("state" = 'pending') = ("email" IS NOT NULL)
    AND ("state" = 'pending') = ("email_normalized" IS NOT NULL)),
  ADD CONSTRAINT "invitations_email_check" CHECK (char_length("email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "invitations_email_normalized_check" CHECK (
    "email_normalized" = lower("email_normalized" COLLATE "C")
    AND "email_normalized" = btrim("email_normalized")
    AND "email_normalized" IS NFC NORMALIZED
    AND char_length("email_normalized") BETWEEN 3 AND 254
    AND position('@' in "email_normalized") > 1),
  ADD CONSTRAINT "invitations_token_check" CHECK (("token_hash" IS NULL) = ("expires_at" IS NULL)),
  ADD CONSTRAINT "invitations_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "invitations_decided_check" CHECK (("state" = 'pending') = ("decided_at" IS NULL)),
  ADD CONSTRAINT "invitations_accepted_check" CHECK (("state" = 'accepted') = ("accepted_account_id" IS NOT NULL)),
  ADD CONSTRAINT "invitations_version_check" CHECK ("version" >= 1);

-- One pending invitation per kind and address in a Market. Invisible to Prisma.
CREATE UNIQUE INDEX "invitations_market_id_kind_email_pending_key" ON "identity"."invitations" ("market_id", "kind", "email_normalized") WHERE "state" = 'pending';

-- The relay's claim. Invisible to Prisma.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "identity"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants to the application's group role. No account is ever deleted by the application
-- (an account is disabled), the outbox envelope and the inbox are append-only, and a merchant
-- or a membership changes only its state.
GRANT USAGE ON SCHEMA "identity" TO "drive_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "identity"."outbox" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "identity"."inbox" TO "drive_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "identity"."accounts" TO "drive_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "identity"."password_credentials" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sessions" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_throttles" TO "drive_app";
GRANT SELECT, INSERT, DELETE ON TABLE "identity"."sign_in_records" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."one_time_links" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "identity"."merchants" TO "drive_app";
GRANT UPDATE ("state", "state_changed_at", "version") ON TABLE "identity"."merchants" TO "drive_app";
GRANT SELECT, INSERT ON TABLE "identity"."merchant_memberships" TO "drive_app";
GRANT UPDATE ("state", "removed_at", "version") ON TABLE "identity"."merchant_memberships" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."roles" TO "drive_app";
GRANT SELECT, INSERT, DELETE ON TABLE "identity"."role_permissions" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."role_assignments" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."second_factors" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."recovery_codes" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_challenges" TO "drive_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."invitations" TO "drive_app";
