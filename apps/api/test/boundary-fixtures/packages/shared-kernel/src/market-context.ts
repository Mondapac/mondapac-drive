import { mint } from './minted';

export interface MarketContext {
  readonly marketId: string;
  readonly tenantId: string;
}

export function mintMarketContext(marketId: string, tenantId: string): MarketContext {
  return mint({ marketId, tenantId });
}
