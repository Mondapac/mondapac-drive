/** A Market code from config/markets/. Core code never names a specific one. */
export type MarketId = string & { readonly __brand: 'MarketId' };

export function marketId(code: string): MarketId {
  if (!/^[A-Z]{2,8}$/.test(code)) {
    throw new RangeError(`Market code must be 2 to 8 capital letters, got "${code}"`);
  }
  return code as MarketId;
}
