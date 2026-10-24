// ADR-0025 condition (b), by type: `MarketTransaction` exposes model delegates only (platform
// persistence design 3.3 and 13). Checked by `pnpm typecheck` (apps/api/tsconfig.json includes
// test/); nothing here runs. Each `@ts-expect-error` fails the typecheck if the member it
// marks ever becomes reachable. The run-time half is in test/db/unit-of-work.db-spec.ts.
import type { Prisma } from '../../src/generated/prisma/client';
import type { MarketTransaction } from '../../src/platform/persistence/prisma.service';

declare const tx: MarketTransaction;

/** The model delegates are there. */
export const delegates = [tx.subjectKey.findMany, tx.subjectKey.create] as const;

/** Every client-level member is absent. */
export const absent = [
  // @ts-expect-error no $transaction: a nested transaction would join the unit silently
  tx.$transaction,
  // @ts-expect-error no raw SQL
  tx.$queryRaw,
  // @ts-expect-error no raw SQL
  tx.$executeRaw,
  // @ts-expect-error no raw SQL
  tx.$queryRawUnsafe,
  // @ts-expect-error no raw SQL
  tx.$executeRawUnsafe,
  // @ts-expect-error no raw SQL
  tx.$queryRawTyped,
  // @ts-expect-error no connection control
  tx.$connect,
  // @ts-expect-error no connection control
  tx.$disconnect,
  // @ts-expect-error no event subscription
  tx.$on,
  // @ts-expect-error no further extension
  tx.$extends,
] as const;

/**
 * The audit models are not in the view (Hassan M1 on slice 6a): only the AuditWriter reaches
 * them, through `auditTx` in platform/persistence/audit/.
 */
export const auditAbsent = [
  // @ts-expect-error no audit_log: write it through the AuditWriter
  tx.auditLog,
  // @ts-expect-error no audit_log_seal
  tx.auditLogSeal,
  // @ts-expect-error no audit_chain_checkpoint
  tx.auditChainCheckpoint,
] as const;

/** A delegate holds its guarded operations only: not the client it came from (Hassan, H1). */
export const delegateAbsent = [
  // @ts-expect-error no $parent: it is the unguarded client
  tx.subjectKey.$parent,
  // @ts-expect-error no $name
  tx.subjectKey.$name,
  // @ts-expect-error no field references
  tx.subjectKey.fields,
] as const;

/** The view cannot be written to. */
export function assign(other: MarketTransaction['subjectKey']): void {
  // @ts-expect-error readonly
  tx.subjectKey = other;
}

/** Prisma's own transaction client is not a MarketTransaction, and the reverse. */
export function convert(prismaTx: Prisma.TransactionClient): void {
  // @ts-expect-error the base transaction client has $-members and is not guarded
  const asMarket: MarketTransaction = prismaTx;
  // @ts-expect-error a MarketTransaction is not a Prisma transaction client
  const asPrisma: Prisma.TransactionClient = tx;
  void asMarket;
  void asPrisma;
}
