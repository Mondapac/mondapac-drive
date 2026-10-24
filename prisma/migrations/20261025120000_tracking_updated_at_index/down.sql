-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025120000_tracking_updated_at_index.
DROP INDEX IF EXISTS "tracking"."tracked_deliveries_market_id_updated_at_idx";
