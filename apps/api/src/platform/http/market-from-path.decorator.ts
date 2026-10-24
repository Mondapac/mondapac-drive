import { SetMetadata } from '@nestjs/common';

/** The route parameter that names the Market on a controller marked {@link MarketFromPath}. */
export const MARKET_PATH_PARAM = 'market';

const MARKET_FROM_PATH = 'mondapac:market-from-path';

/**
 * Takes a controller's Market from its `:market` route parameter instead of `x-market-id`: for
 * callers that cannot set a header, such as a payment provider's webhook (Phase 5 package 2).
 * The value meets the same checks as the header (pattern and HOSTED_MARKETS) in
 * MarketContextGuard; nothing else changes. Class-level only, and read from the class itself.
 */
export function MarketFromPath(): ClassDecorator {
  return SetMetadata(MARKET_FROM_PATH, true);
}

/** True when a controller class itself carries {@link MarketFromPath}. */
export function takesMarketFromPath(controller: object): boolean {
  return Reflect.getOwnMetadata(MARKET_FROM_PATH, controller) === true;
}
