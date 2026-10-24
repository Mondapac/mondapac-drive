import { canonicalJson, encodeAuditFields } from '@mondapac-drive/shared-kernel';
import { MAX_AUDIT_SIDE_BYTES } from '../../../../platform/audit/audit-writer';
import { RoleSeedApplied } from '../../domain/audit';

/**
 * The byte budget of one seeded role's keys (identity design 5.6; slice 8a-1, Ali's ruling on
 * Mohammad's review of the key length). One `identity.role.seed-applied` row lists the keys an
 * upgrade adds and the keys it removes in one `after`, which must stay within the audit writer's
 * `MAX_AUDIT_SIDE_BYTES` (PA W4). Keys may be up to `MAX_PERMISSION_KEY_LENGTH` (128, the stored
 * column's CHECK) characters, so a count cap alone does not bound the row; this budget does:
 *
 * - `overhead` is measured, not assumed: the canonical JSON of a row with both lists empty and
 *   the largest `seedVersion` the column holds (2_147_483_647), through the writer's own
 *   encoding (`encodeAuditFields`, `canonicalJson`);
 * - each list gets half of what is left: `budget = floor((MAX_AUDIT_SIDE_BYTES - overhead) / 2)`;
 * - a role's cost is the sum of (key length + 3) over its keys: the key, its two quotes and one
 *   comma (keys are ASCII by their pattern, so a character is a byte). This over-counts each
 *   list by one comma.
 *
 * `checkRoleSeed` and `checkRoleSeedKeys` refuse a role over the budget (`keys-too-large`), at
 * boot and on every seed run, besides the separate 40-key cap. Why it holds for every upgrade:
 * "added" is a subset of the new version's keys, which passed the budget; "removed" is a subset
 * of a previous version's keys, which passed the same budget when it shipped. If this formula
 * ever changes, every older entry of test/contracts/role-seed.snapshot.json must be re-checked
 * against the new one, since a Market that is behind can still upgrade from it.
 */
function measuredOverhead(): number {
  const encoded = encodeAuditFields(
    RoleSeedApplied.after,
    { seedVersion: 2_147_483_647, addedKeys: [], removedKeys: [] },
    { isKnownPermissionKey: () => true },
  );
  if (!encoded.ok) throw new Error('role-seed-budget: the empty seed-applied row does not encode');
  const text = canonicalJson(encoded.value);
  if (!text.ok) {
    throw new Error('role-seed-budget: the empty seed-applied row has no canonical JSON');
  }
  return Buffer.byteLength(text.value, 'utf8');
}

/** Bytes of canonical JSON of an empty `seed-applied` after, at the largest seed version. */
export const SEED_APPLIED_OVERHEAD_BYTES = measuredOverhead();

/** The most one role's keys may cost, by {@link seedKeysCost}. */
export const SEED_KEYS_BUDGET_BYTES = Math.floor(
  (MAX_AUDIT_SIDE_BYTES - SEED_APPLIED_OVERHEAD_BYTES) / 2,
);

/** What a role's keys cost in one list of a `seed-applied` row: Σ (length + 3). */
export function seedKeysCost(keys: readonly string[]): number {
  return keys.reduce((sum, key) => sum + key.length + 3, 0);
}

/** True when a role's keys fit {@link SEED_KEYS_BUDGET_BYTES}. */
export function fitsSeedKeysBudget(keys: readonly string[]): boolean {
  return seedKeysCost(keys) <= SEED_KEYS_BUDGET_BYTES;
}
