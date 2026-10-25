-- Down of 20261027050000: the inboxes are append-only again (rows already purged stay gone).
REVOKE DELETE ON TABLE "delivery"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "dispatch"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "fleet"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "identity"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "notifications"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "payouts"."inbox" FROM "drive_app";
REVOKE DELETE ON TABLE "tracking"."inbox" FROM "drive_app";
