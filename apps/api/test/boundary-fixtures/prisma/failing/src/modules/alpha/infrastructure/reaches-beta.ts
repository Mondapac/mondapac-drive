// Violations: alpha's infrastructure names beta's model in every form the check reads.
import type { BetaThing, Prisma } from '../../../generated/prisma/client';
import type { BetaThingModel } from '../../../generated/prisma/models/BetaThing';

declare const tx: Record<string, { findMany(args: unknown): Promise<unknown> }>;

export async function list(where: Prisma.BetaThingWhereInput): Promise<BetaThing[]> {
  await tx['betaThing'].findMany({ where });
  return (await tx.betaThing.findMany({ where })) as BetaThingModel[];
}
