import type { MarketContextFactory } from './market-context.factory';
import { attachMarketContext } from './market.decorator';
import { EXEMPTION_KEY } from './no-market-context.decorator';

// Allowed: the guard reads the exemption and is the only file that attaches a context.
export function isMarketContextExempt(metadata: { key?: string }): boolean {
  return metadata.key === EXEMPTION_KEY;
}

export class MarketContextGuard {
  constructor(private readonly factory: MarketContextFactory) {}

  canActivate(request: object, marketId: string): boolean {
    attachMarketContext(request, this.factory.forMarket(marketId));
    return true;
  }
}
