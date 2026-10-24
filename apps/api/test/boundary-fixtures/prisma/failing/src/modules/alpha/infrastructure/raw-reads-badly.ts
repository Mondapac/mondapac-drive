// Violations: an id that is not in the list, an id that is not a literal, a statement of
// another module's id, and raw SQL outside the platform files.
declare const port: { rawRead: (market: unknown, id: string, params: unknown) => unknown };
declare const db: Record<string, (...args: unknown[]) => unknown>;
declare const dynamicId: string;

export function bad(market: unknown): unknown[] {
  return [
    port.rawRead(market, 'alpha.missing', {}),
    port.rawRead(market, dynamicId, {}),
    db.$queryRawUnsafe('SELECT 1'),
    db['$executeRaw']('SELECT 1'),
  ];
}
