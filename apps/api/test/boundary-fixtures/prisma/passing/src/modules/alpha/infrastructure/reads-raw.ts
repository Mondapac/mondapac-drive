// Allowed: the owning module calls its own statement by a literal id.
declare const port: { rawRead: (market: unknown, id: string, params: unknown) => unknown };

export function read(market: unknown): unknown {
  return port.rawRead(market, 'alpha.parents-of-kind', { kind: 'x' });
}
