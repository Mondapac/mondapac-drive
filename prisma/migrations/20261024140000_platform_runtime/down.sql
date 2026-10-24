-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261024140000_platform_runtime, newest part first: grants, triggers, tables,
-- functions, the btree_gist extension and the schemas. It fails while a table of another module
-- still uses btree_gist's operator class, which is right: that migration is reversed first.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."rate_limit_counters" FROM "drive_app";
DROP TABLE "platform"."rate_limit_counters";

REVOKE SELECT, INSERT ON TABLE "platform"."audit_chain_checkpoint" FROM "drive_app";
REVOKE SELECT, INSERT ON TABLE "platform"."audit_log_seal" FROM "drive_app";
DROP TRIGGER "audit_chain_checkpoint_no_truncate" ON "platform"."audit_chain_checkpoint";
DROP TRIGGER "audit_chain_checkpoint_no_update_delete" ON "platform"."audit_chain_checkpoint";
DROP TRIGGER "audit_log_seal_no_truncate" ON "platform"."audit_log_seal";
DROP TRIGGER "audit_log_seal_no_update_delete" ON "platform"."audit_log_seal";
DROP TABLE "platform"."audit_chain_checkpoint";
DROP TABLE "platform"."audit_log_seal";
DROP FUNCTION "platform"."audit_chain_reject_mutation"();

REVOKE SELECT, INSERT, UPDATE ("status", "attempts", "next_attempt_at", "error_code", "delivered_at", "dead_at") ON TABLE "platform"."event_delivery" FROM "drive_app";
DROP TABLE "platform"."event_delivery";

DROP EXTENSION "btree_gist";
DROP SCHEMA "extensions";

REVOKE SELECT, INSERT, UPDATE ("wrapped_key", "wrapping_key_id", "rewrapped_at", "destroyed_at") ON TABLE "platform"."subject_keys" FROM "drive_app";
DROP TRIGGER "subject_keys_one_way" ON "platform"."subject_keys";
DROP TABLE "platform"."subject_keys";
DROP FUNCTION "platform"."subject_keys_guard_update"();

REVOKE SELECT, INSERT ON TABLE "platform"."audit_log" FROM "drive_app";
REVOKE USAGE ON SCHEMA "platform" FROM "drive_app";
DROP TRIGGER "audit_log_no_truncate" ON "platform"."audit_log";
DROP TRIGGER "audit_log_no_update_delete" ON "platform"."audit_log";
DROP TABLE "platform"."audit_log";
DROP FUNCTION "platform"."audit_log_reject_mutation"();
DROP SCHEMA "platform";
