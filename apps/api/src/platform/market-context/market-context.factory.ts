import { Inject, Injectable } from '@nestjs/common';
import { err, mintMarketContext, ok, parseMarketId } from '@mondapac-drive/shared-kernel';
import type { MarketContext, Result, TenantId } from '@mondapac-drive/shared-kernel';
import { MarketRegistry } from '../market-config/market-registry';
import { TENANT_ID } from './tenant';

/** Why a Market code gave no context. A closed union with stable codes and no input text. */
export type MarketContextError =
  { readonly code: 'market-id.invalid' } | { readonly code: 'market.not-hosted' };

/**
 * The only production constructor of a `MarketContext` (platform-foundations 5.1): it parses
 * the code, asks the registry whether this Region Stack hosts the Market, adds the tenant
 * constant and mints the context. It never substitutes a Market, and "hosted" is its only
 * gate in Phase 2 (ADR-0020 decision 4).
 *
 * Every entry adapter (HTTP request, scheduled job, consumed event) goes through it. Modules
 * never call it: they receive the context from their entry adapter (rule 5 of 8.2).
 */
@Injectable()
export class MarketContextFactory {
  constructor(
    private readonly registry: MarketRegistry,
    @Inject(TENANT_ID) private readonly tenantId: TenantId,
  ) {}

  forMarket(code: string): Result<MarketContext, MarketContextError> {
    const marketId = parseMarketId(code);
    if (!marketId.ok) return err({ code: 'market-id.invalid' });
    if (!this.registry.isHosted(marketId.value)) return err({ code: 'market.not-hosted' });
    return ok(mintMarketContext(marketId.value, this.tenantId));
  }
}
