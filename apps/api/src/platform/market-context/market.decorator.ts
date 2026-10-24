import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { marketContextOf } from './attached-market-context';

// Reading only: attaching a request's Market is MarketContextGuard's, through
// attached-market-context.ts (W3; dependency-cruiser `market-context-is-attached-by-the-guard`).
export { marketContextOf, MissingMarketContextError } from './attached-market-context';

/**
 * Parameter decorator: the minted `MarketContext` that MarketContextGuard resolved for this
 * request. It throws when nothing is attached (an exempt controller), so no handler ever
 * runs with a default Market.
 */
export const Market = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MarketContext =>
    marketContextOf(context.switchToHttp().getRequest<object>()),
);
