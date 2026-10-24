import type * as factories from '../../../platform/market-context/market-context.factory';
import * as kernel from '@mondapac-drive/shared-kernel';

// Violations: a re-export, a destructured name (also computed), a computed member and a
// qualified type all reach the minting names.
export { mintMarketContext } from '@mondapac-drive/shared-kernel';
const { mintMarketContext: mint } = kernel;
const { ['mintMarketContext']: mintByLiteral } = kernel;

export function violation(factory: factories.MarketContextFactory): unknown[] {
  return [mint('ZZ', 'mondapac'), mintByLiteral, kernel['mintMarketContext'], factory];
}
