import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';

// W3 of platform-foundations 8.2 (identity slice 1d): the request-to-Market map lives in this
// file, which only MarketContextGuard and the `@Market()` decorator file may import
// (dependency-cruiser `market-context-is-attached-by-the-guard`). Other code reads the Market
// through `@Market()` or `marketContextOf` from market.decorator.ts.

/** A controller asked for the Market of a request that has none: a programmer error. */
export class MissingMarketContextError extends Error {
  constructor() {
    super(
      'No MarketContext is attached to this request. @Market() needs a market-scoped ' +
        'controller; an exempt controller has no Market and gets no default.',
    );
    this.name = 'MissingMarketContextError';
  }
}

// The context of each request, keyed by the request object. Private to this file.
const attached = new WeakMap<object, MarketContext>();

/**
 * Attaches the resolved Market to a request; called by MarketContextGuard only. Refuses a
 * context the kernel did not mint (a literal, a copy, a value from another copy of the
 * kernel) and a second context on the same request.
 */
export function attachMarketContext(request: object, market: MarketContext): void {
  if (!isMinted(market)) {
    throw new TypeError('attachMarketContext: the MarketContext was not minted by the kernel');
  }
  if (attached.has(request)) {
    throw new Error('attachMarketContext: this request already has a MarketContext');
  }
  attached.set(request, market);
}

/** The Market attached to a request. Throws when there is none: it never defaults. */
export function marketContextOf(request: object): MarketContext {
  const market = attached.get(request);
  if (market === undefined) throw new MissingMarketContextError();
  return market;
}
