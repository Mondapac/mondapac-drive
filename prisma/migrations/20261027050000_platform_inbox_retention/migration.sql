-- Handoff 35: platform.inbox-retention deletes handled inbox rows past the Market's
-- events.inboxRetentionDays. The application role gains DELETE on every module inbox and on
-- nothing else; inbox rows hold ids and handler names only.
GRANT DELETE ON TABLE "delivery"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "dispatch"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "fleet"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "identity"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "notifications"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "payouts"."inbox" TO "drive_app";
GRANT DELETE ON TABLE "tracking"."inbox" TO "drive_app";
