import type { Prisma } from '../../generated/prisma/client';
import { GUARDED_OPERATIONS, marketGuardExtension, type GuardedOperation } from './market-guard';
import type { ModelMap, ModelMapEntry } from './model-map';
import type { PrismaRoot } from './prisma-root';
import { unitStorage } from './unit-store';

/**
 * The guarded client (platform persistence design, "P", 3.3 and 4.2): the base client with
 * the market guard applied once. Read-write units open their interactive transactions on it,
 * read-only units query it directly (ADR-0025); both reach the database only through the
 * guard. Internal to `platform/persistence/`.
 */
export function createGuardedClient(root: PrismaRoot, map: ModelMap) {
  return root.$extends(marketGuardExtension(map, () => unitStorage.getStore()));
}

export type GuardedClient = ReturnType<typeof createGuardedClient>;

/** Nest token of the guarded client; not exported from the persistence module. */
export const GUARDED_CLIENT = Symbol('GUARDED_CLIENT');

/** The client property of each model (`auditLog`): the model delegates and nothing else. */
type ModelProperty = Uncapitalize<Prisma.ModelName>;

/** One model's part of the view: the guarded operations of its delegate, nothing else. */
type DelegateView<Delegate> = Readonly<Pick<Delegate, Extract<keyof Delegate, GuardedOperation>>>;

/**
 * The audit tables of `platform.prisma` (docs/design/domain/platform-audit.md 2; Hassan M1 on
 * slice 6a): reserved to `platform/persistence/audit/`. Their delegates are not in the view
 * `PrismaService.tx(market)` hands out, so no repository can write or read an audit row past
 * the AuditWriter; the writer reaches them through its own view of the same unit.
 */
export const AUDIT_TABLES: readonly string[] = Object.freeze([
  'audit_log',
  'audit_log_seal',
  'audit_chain_checkpoint',
]);

/** The client properties of the audit models: the type-level half of {@link AUDIT_TABLES}. */
export const AUDIT_PROPERTIES = Object.freeze([
  'auditLog',
  'auditLogSeal',
  'auditChainCheckpoint',
] as const satisfies readonly ModelProperty[]);
type AuditProperty = (typeof AUDIT_PROPERTIES)[number];

/**
 * What `PrismaService.tx(market)` hands a repository: per model, the guarded operations of
 * the open unit's client and nothing else. No `$transaction`, no raw SQL, no `$connect`,
 * `$disconnect`, `$on` or `$extends` (ADR-0025 condition (b)); no `$parent`, `$name` or
 * `fields` on a delegate either (Hassan, H1). A type test proves each `$` member is absent.
 * `Prisma.TransactionClient` is assignable to it in neither direction (P 3.3). The audit
 * models are not in it (Hassan M1): see {@link AuditTransaction}.
 */
export type MarketTransaction = {
  readonly [Property in Exclude<ModelProperty, AuditProperty>]: DelegateView<
    GuardedClient[Property]
  >;
};

/**
 * The audit models of the open unit, guarded like every other model: what the AuditWriter
 * (and, from slice 6b, the sealer) uses, through `auditTx(market)` in
 * `platform/persistence/audit/`. Never handed to module code.
 */
export type AuditTransaction = {
  readonly [Property in AuditProperty]: DelegateView<GuardedClient[Property]>;
};

const isAuditModel = (entry: ModelMapEntry): boolean =>
  entry.module === 'platform' && AUDIT_TABLES.includes(entry.table);

/** The audit models of the map; throws when they no longer match {@link AUDIT_PROPERTIES}. */
function auditEntries(map: ModelMap): ModelMapEntry[] {
  const entries = Object.values(map.models).filter(isAuditModel);
  const properties = entries.map((entry) => entry.clientProperty).sort();
  if (properties.join(',') !== [...AUDIT_PROPERTIES].sort().join(',')) {
    throw new Error('The audit models of the model map do not match AUDIT_PROPERTIES');
  }
  return entries;
}

/**
 * The run-time half of condition (b), for read-write units (on the transaction client) and
 * read-only units (on the guarded base client) alike. The view and each of its delegates are
 * frozen objects with no prototype. A delegate holds only the functions of
 * {@link GUARDED_OPERATIONS}, each bound to Prisma's delegate: Prisma's delegate itself is
 * never reachable, because it carries `$parent`, the client it came from (the unguarded
 * base client, or the unguarded interactive-transaction client). The audit models are left
 * out (Hassan M1).
 */
export function modelDelegatesOf(client: object, map: ModelMap): MarketTransaction {
  auditEntries(map);
  const entries = Object.values(map.models).filter((entry) => !isAuditModel(entry));
  return viewOf(client, entries) as MarketTransaction;
}

/** The audit models only, built the same way: the open unit's internal audit view. */
export function auditDelegatesOf(client: object, map: ModelMap): AuditTransaction {
  return viewOf(client, auditEntries(map)) as AuditTransaction;
}

function viewOf(client: object, entries: readonly ModelMapEntry[]): object {
  const view: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const entry of entries) {
    const delegate = (client as Record<string, unknown>)[entry.clientProperty] as Record<
      string,
      unknown
    >;
    const operations: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const operation of GUARDED_OPERATIONS) {
      const action = delegate[operation];
      if (typeof action !== 'function') {
        throw new Error(`Prisma delegate ${entry.clientProperty} has no ${operation}`);
      }
      operations[operation] = (action as (...args: unknown[]) => unknown).bind(delegate);
    }
    view[entry.clientProperty] = Object.freeze(operations);
  }
  return Object.freeze(view);
}
