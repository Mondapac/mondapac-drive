export function violation(marketId: string): string {
  return marketId === 'AU' ? 'AUD' : `price in ${marketId}`;
}
