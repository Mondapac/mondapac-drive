// Violations: a model hidden from the property check by destructuring or by a computed key
// on a tx(...) result, and the audit models, which are reserved to platform/persistence/audit/.
type View = Record<string, { findMany(args: unknown): Promise<unknown> }>;
declare const prisma: { tx(market: unknown): View };
declare const market: unknown;
declare const key: string;

export async function hide(): Promise<void> {
  const { betaThing } = prisma.tx(market);
  const { ['betaThing']: quoted, auditLog: audit } = prisma.tx(market);
  const { [key]: computed } = prisma.tx(market);
  await prisma.tx(market)[key]!.findMany({});
  await prisma.tx(market).auditLog.findMany({});
  void [betaThing, quoted, audit, computed];
}
