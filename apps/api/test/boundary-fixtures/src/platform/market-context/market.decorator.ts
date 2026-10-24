import type { MarketContext } from '@mondapac-drive/shared-kernel';

const attached = new WeakMap<object, MarketContext>();

export function attachMarketContext(request: object, market: MarketContext): void {
  attached.set(request, market);
}

export function marketContextOf(request: object): MarketContext | undefined {
  return attached.get(request);
}

export function Market(): ParameterDecorator {
  return () => undefined;
}
