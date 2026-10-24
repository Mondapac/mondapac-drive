/**
 * The label of an encrypted field, `<module>.<record>.<field>` (platform-foundations design 4
 * row 3). A branded constant declared in the owning module's `infrastructure/` with
 * {@link fieldLabel}, never built from input. It is bound into the ciphertext, so a value
 * copied to another field does not decrypt.
 */
export type FieldLabel = string & { readonly __brand: 'FieldLabel' };

/**
 * What a keyed hash is for, `<module>.<purpose>` (PF 4 rows 3 and 4). Hashes of different
 * purposes are computed under different keys and cannot be compared.
 */
export type HashPurpose = string & { readonly __brand: 'HashPurpose' };

const SEGMENT = '[a-z][a-z0-9-]*';
const FIELD_LABEL = new RegExp(`^${SEGMENT}\\.${SEGMENT}\\.${SEGMENT}$`);
const HASH_PURPOSE = new RegExp(`^${SEGMENT}(\\.${SEGMENT}){1,2}$`);

/** Declares a field label; a malformed one is a programmer error, refused at load. */
export function fieldLabel(label: string): FieldLabel {
  if (typeof label !== 'string' || !FIELD_LABEL.test(label) || label.length > 128) {
    throw new TypeError('A field label is "<module>.<record>.<field>" in lower case');
  }
  return label as FieldLabel;
}

/** Declares a hash purpose; a malformed one is a programmer error, refused at load. */
export function hashPurpose(purpose: string): HashPurpose {
  if (typeof purpose !== 'string' || !HASH_PURPOSE.test(purpose) || purpose.length > 128) {
    throw new TypeError('A hash purpose is "<module>.<purpose>" in lower case');
  }
  return purpose as HashPurpose;
}
