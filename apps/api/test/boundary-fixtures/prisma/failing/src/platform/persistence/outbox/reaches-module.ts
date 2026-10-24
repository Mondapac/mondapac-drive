// Violation: the outbox folder reaches outbox and inbox models only, nothing else of a module.
declare const tx: Record<string, { findMany(args: unknown): Promise<unknown> }>;

export async function read(): Promise<void> {
  await tx.alphaOutbox.findMany({});
  await tx.betaThing.findMany({});
}
