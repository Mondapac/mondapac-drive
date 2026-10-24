/**
 * The shape of the generated model map (platform persistence design, "P", section 9),
 * written by scripts/generate-model-map.mjs to `src/generated/model-map.ts` on every
 * `prisma generate`. The guard, and later the outbox writer and relay, read it.
 */
export interface ModelMap {
  readonly models: Readonly<Record<string, ModelMapEntry>>;
  readonly modules: Readonly<Record<string, ModuleMapEntry>>;
}

export interface ModelMapEntry {
  /** The owning module: the schema file's name. */
  readonly module: string;
  readonly schema: string | null;
  readonly table: string;
  /** The property of the client that holds the model's delegate (`auditLog`). */
  readonly clientProperty: string;
  /** `scoped`: has marketId and tenantId; `exempt`: `/// @market-scope none: <reason>`. */
  readonly scope: 'scoped' | 'exempt' | 'invalid';
  readonly scalarFields: readonly string[];
  /** Every relation field of the model, both sides of each relation. */
  readonly relationFields: readonly string[];
  /** The single-column `@id` field, when the model has one. */
  readonly idField: string | null;
  /** Compound `@@id` and `@@unique` selectors under Prisma's names (`name:` or fields joined by `_`). */
  readonly compoundSelectors: readonly CompoundSelector[];
  /** The owning side of each relation (PM6). */
  readonly foreignKeys: readonly ForeignKeyEntry[];
}

export interface CompoundSelector {
  readonly name: string;
  readonly fields: readonly string[];
}

export interface ForeignKeyEntry {
  readonly field: string;
  readonly target: string;
  readonly targetTable: string;
  readonly fields: readonly string[];
  readonly references: readonly string[];
  readonly columns: readonly string[];
  readonly referencedColumns: readonly string[];
}

export interface ModuleMapEntry {
  readonly schema: string;
  readonly outboxModel: string | null;
  readonly inboxModel: string | null;
}
