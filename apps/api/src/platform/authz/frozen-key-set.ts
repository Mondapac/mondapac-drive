/** Every set {@link frozenKeySet} built; mutation is refused once the set is in here. */
const frozen = new WeakSet<object>();

/**
 * A `Set` whose content cannot change after construction (R-3 review N-2): `add`, `delete` and
 * `clear` throw, and the object itself is frozen. `Object.freeze` alone does not stop a `Set`
 * from changing, because its entries are internal slots, not properties. The registry hands
 * these out, so no caller can widen the keys of a scope for every later check.
 *
 * It guards against accidental mutation by our own code, not against hostile code running in the
 * same process: such code could reach `Set.prototype` methods or the registry's internals by
 * other means (Hassan I-1). The registry's trust boundary is the process.
 */
class FrozenKeySet extends Set<string> {
  constructor(values: Iterable<string>) {
    // The base constructor calls `add` for each value, before the set is marked frozen.
    super(values);
    frozen.add(this);
    Object.freeze(this);
  }

  override add(value: string): this {
    if (frozen.has(this)) throw new TypeError('A permission key set is frozen');
    return super.add(value);
  }

  override delete(): boolean {
    throw new TypeError('A permission key set is frozen');
  }

  override clear(): void {
    throw new TypeError('A permission key set is frozen');
  }
}

/** A frozen set of permission keys (N-2): read-only for its whole life. */
export function frozenKeySet(values: Iterable<string> = []): ReadonlySet<string> {
  return new FrozenKeySet(values);
}

/** True only for a set {@link frozenKeySet} built. */
export function isFrozenKeySet(value: unknown): boolean {
  return typeof value === 'object' && value !== null && frozen.has(value);
}
