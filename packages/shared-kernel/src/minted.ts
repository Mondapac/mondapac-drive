// Minted values (platform-foundations design 3.7).
//
// A context type can be written as an object literal by any code, so its type alone proves
// nothing about where a value came from. A minted value is created only by a kernel
// function, frozen, and recorded here. Other code can ask one question: `isMinted(value)`.
//
// Consequences: a minted value cannot be rebuilt from JSON or copied with a spread, and one
// process must load exactly one copy of this module.

// The brand exists in the type system only. No symbol is created at run time, so there is
// nothing to read from a minted value and copy onto another object.
declare const brand: unique symbol;

/** Compile-time mark of a minted type. Code outside this file cannot name the property. */
export interface Minted<Name extends string> {
  readonly [brand]: Name;
}

const minted = new WeakSet<object>();

/**
 * Kernel-internal: the single place where a value becomes minted. It is called only by the
 * constructor function of each minted type and is exported from neither package entry.
 *
 * The fields are copied into a new object, so no caller holds a reference to the value
 * before it is frozen, and the value is frozen before it is recorded.
 */
export function mint<T extends Minted<string>>(fields: Omit<T, typeof brand>): T {
  const value = Object.freeze({ ...fields });
  minted.add(value);
  return value as T;
}

/** True only for the very object a kernel constructor function returned. */
export function isMinted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && minted.has(value);
}
