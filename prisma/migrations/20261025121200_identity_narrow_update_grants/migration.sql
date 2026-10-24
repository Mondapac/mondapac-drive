-- Narrow the application role's UPDATE on identity.accounts and identity.sessions to the columns
-- the application writes (Hassan, WP2 review): an account never changes its id, Market,
-- population or email by an UPDATE, and a session never changes its account, population,
-- merchant, transport, label or lifetime.
REVOKE UPDATE ON TABLE "identity"."accounts" FROM "drive_app";
GRANT UPDATE ("display_name", "timezone", "locale", "status", "email_verified_at", "signed_up_at", "version") ON TABLE "identity"."accounts" TO "drive_app";

REVOKE UPDATE ON TABLE "identity"."sessions" FROM "drive_app";
GRANT UPDATE ("last_seen_at", "revoked_at", "revoked_reason", "token_hash") ON TABLE "identity"."sessions" TO "drive_app";
