// Allowed: the named exception. platform/persistence/outbox/ reaches every module's outbox and
// inbox models.
declare const tx: Record<string, { findMany(args: unknown): Promise<unknown> }>;

export async function claim(): Promise<void> {
  await tx.alphaOutbox.findMany({});
  await tx.betaOutbox.findMany({});
  await tx.betaInbox.findMany({});
}
