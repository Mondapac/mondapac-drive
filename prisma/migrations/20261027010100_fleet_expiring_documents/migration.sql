-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Fleet (handoff 31): the panel lists the verified documents that run out soon, soonest first.

-- CreateIndex
CREATE INDEX "documents_market_id_tenant_id_status_expires_at_id_idx" ON "fleet"."documents"("market_id", "tenant_id", "status", "expires_at", "id");
