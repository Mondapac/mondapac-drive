import { Controller, Get, Search } from '@nestjs/common';
import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { Market } from '../../src/platform/market-context/market.decorator';
import { NoMarketContext } from '../../src/platform/market-context/no-market-context.decorator';

/**
 * Test-only. Slice 0 has no market-scoped endpoint, so the market tests register this
 * controller: it returns the Market the request was resolved to.
 */
@Controller('test/market')
export class MarketEchoController {
  @Get()
  echo(@Market() market: MarketContext): { marketId: string; tenantId: string; minted: boolean } {
    return { marketId: market.marketId, tenantId: market.tenantId, minted: isMinted(market) };
  }

  /** Takes no Market parameter: the route is market-scoped all the same (no opt-in). */
  @Get('plain')
  plain(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** A method outside OpenAPI's fixed list: its operation must get the header too. */
  @Search('search')
  search(@Market() market: MarketContext): { marketId: string } {
    return { marketId: market.marketId };
  }
}

/** Test-only. An exempt controller that wrongly asks for the Market: `@Market()` must throw. */
@NoMarketContext()
@Controller('test/exempt')
export class ExemptMarketReaderController {
  @Get()
  read(@Market() market: MarketContext): { marketId: string } {
    return { marketId: market.marketId };
  }
}
