-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The retention purge finds deliveries stuck in a status by their last report (security review
-- of tracking, PR #8).
CREATE INDEX "tracked_deliveries_market_id_updated_at_idx" ON "tracking"."tracked_deliveries"("market_id", "updated_at");
