import { mintMarketContext } from '@mondapac-drive/shared-kernel';
import * as kernel from '@mondapac-drive/shared-kernel';
import { MarketContextFactory } from '../../../platform/market-context/market-context.factory';

// Violations: a module mints no context, whatever the import form, and uses no factory.
export const violation = [
  mintMarketContext('ZZ', 'mondapac'),
  kernel.mintMarketContext('ZZ', 'mondapac'),
  new MarketContextFactory().forMarket('ZZ'),
];
