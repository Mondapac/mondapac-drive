export const EXEMPTION_KEY = 'market-context-exemption';

export function NoMarketContext(): { key: string } {
  return { key: EXEMPTION_KEY };
}
