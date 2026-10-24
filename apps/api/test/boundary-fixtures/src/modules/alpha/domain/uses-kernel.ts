import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';

// Allowed: domain/ may import the shared kernel, by its package name.
export function allowed(market: MarketContext): boolean {
  return isMinted(market);
}
