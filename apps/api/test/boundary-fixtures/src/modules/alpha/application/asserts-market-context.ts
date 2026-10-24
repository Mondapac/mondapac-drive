import type { MarketContext } from '@mondapac-drive/shared-kernel';

// Violations: a module never asserts a value to a context type.
export const violation = [
  { marketId: 'ZZ', tenantId: 'mondapac' } as MarketContext,
  <MarketContext>{ marketId: 'ZZ', tenantId: 'mondapac' },
  { marketId: 'ZZ', tenantId: 'mondapac' } as unknown as Readonly<MarketContext>,
];
