// Allowed: alpha's repository names alpha's own models, by client property, by a Prisma type
// and by a type imported from the generated client.
import type { AlphaParent, Prisma } from '../../../generated/prisma/client';

declare const tx: Record<string, { findMany(args: unknown): Promise<unknown> }>;

export async function list(where: Prisma.AlphaParentWhereInput): Promise<AlphaParent[]> {
  await tx.alphaChild.findMany({ where });
  return (await tx.alphaParent.findMany({ where })) as AlphaParent[];
}
