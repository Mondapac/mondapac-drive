// Allowed: the audit models are reserved to platform/persistence/audit/, which names them
// through auditTx(market), by property and by destructuring.
declare function auditTx(
  market: unknown,
): Record<string, { create(args: unknown): Promise<unknown> }>;
declare const market: unknown;

export async function write(): Promise<void> {
  await auditTx(market).auditLog.create({});
  const { auditLog } = auditTx(market);
  await auditLog.create({});
}
