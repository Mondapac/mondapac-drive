import { MAX_PERMISSION_KEY_LENGTH } from '../../src/platform/authz/permission';

/**
 * Distinct, well-formed permission keys of `identity` whose seed cost (Σ length + 3, see
 * `role-seed-budget.ts`) is exactly `cost`, each at most `MAX_PERMISSION_KEY_LENGTH` long, with
 * as many keys of the longest length as the cost allows. `tag` keeps two lists apart. Fixtures
 * only: no registry declares them.
 */
export function keysCosting(cost: number, tag: string): string[] {
  const longest = MAX_PERMISSION_KEY_LENGTH + 3;
  const lengths: number[] = [];
  let left = cost;
  // Keys of the longest length first, then the rest in one key or two.
  while (left > 2 * longest) {
    lengths.push(MAX_PERMISSION_KEY_LENGTH);
    left -= longest;
  }
  if (left <= longest) lengths.push(left - 3);
  else lengths.push(Math.floor(left / 2) - 3, left - Math.floor(left / 2) - 3);
  return lengths.map((length, n) => keyOfLength(length, tag, n));
}

/** `count` distinct keys, each as long as possible within `cost` together. */
export function keysWithin(cost: number, count: number, tag: string): string[] {
  const length = Math.min(MAX_PERMISSION_KEY_LENGTH, Math.floor(cost / count) - 3);
  return Array.from({ length: count }, (_, n) => keyOfLength(length, tag, n));
}

/** A key `identity.<tag><n>.vvv…` of exactly `length` characters. */
export function keyOfLength(length: number, tag: string, n: number): string {
  const head = `identity.${tag}${n}.`;
  if (length <= head.length || length > MAX_PERMISSION_KEY_LENGTH) {
    throw new Error(`keyOfLength: no key of length ${length} for ${head}`);
  }
  return `${head}${'v'.repeat(length - head.length)}`;
}
