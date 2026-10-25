-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027010100_fleet_expiring_documents: an index only, no data.
DROP INDEX "fleet"."documents_market_id_tenant_id_status_expires_at_id_idx";
