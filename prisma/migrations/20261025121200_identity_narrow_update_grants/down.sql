-- Restores the table-wide UPDATE of 20261024170000_identity.
REVOKE UPDATE ("display_name", "timezone", "locale", "status", "email_verified_at", "signed_up_at", "version") ON TABLE "identity"."accounts" FROM "drive_app";
GRANT UPDATE ON TABLE "identity"."accounts" TO "drive_app";

REVOKE UPDATE ("last_seen_at", "revoked_at", "revoked_reason", "token_hash") ON TABLE "identity"."sessions" FROM "drive_app";
GRANT UPDATE ON TABLE "identity"."sessions" TO "drive_app";
