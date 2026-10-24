// Violation: a statement of module alpha called from module beta.
declare const port: { rawRead: (market: unknown, id: string, params: unknown) => unknown };

export function bad(market: unknown): unknown {
  return port.rawRead(market, 'alpha.sound', {});
}
