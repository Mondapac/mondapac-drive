// Violations: platform/persistence/ names a module's model (platform owns platform.prisma only)
// and an audit model outside platform/persistence/audit/.
declare const tx: Record<string, { findMany(args: unknown): Promise<unknown> }>;

export async function read(): Promise<void> {
  await tx.auditLog.findMany({});
  await tx.alphaParent.findMany({});
}
