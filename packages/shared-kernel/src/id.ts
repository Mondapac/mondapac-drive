import { err, ok } from './result';
import type { Result } from './result';

/**
 * The identifier of a record or an event: the canonical lower-case text of a version 7
 * UUID (RFC 9562), one to one with a `uuid` column. The brand `K` names the kind of thing
 * identified and exists at compile time only.
 *
 * An id shows its creation time and is not a secret: never use one as a token. Ids are
 * ordered by creation time to the millisecond, with no order inside one millisecond, so
 * nothing may rely on id order for correctness.
 */
export type Id<K extends string = string> = string & { readonly __id: K };

/** The only source of new ids. Implementations are injected; tests use a fake. */
export interface IdGenerator {
  next<K extends string>(): Id<K>;
}

const CANONICAL_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Accepts only the canonical lower-case text of a version 7 UUID. */
export function parseId<K extends string>(
  text: string,
): Result<Id<K>, { readonly code: 'id.invalid' }> {
  // The run-time type check matters: RegExp.test() would turn an array into a string.
  if (typeof text !== 'string' || !CANONICAL_UUID_V7.test(text)) {
    return err({ code: 'id.invalid' });
  }
  return ok(text as Id<K>);
}

const MAX_UNIX_MS = 2 ** 48 - 1;
const RANDOM_BYTES = 10;

/**
 * The RFC 9562 version 7 layout, as a pure function: 48 bits of Unix time in milliseconds,
 * the version, 12 random bits, the variant, 62 random bits. Of the 10 random bytes the high
 * 4 bits of byte 0 and the high 2 bits of byte 2 are not used (74 random bits remain).
 *
 * The caller supplies the time and the random bytes; the kernel has no clock and no random
 * source. Bad input is a programmer error and throws `RangeError`.
 */
export function uuidV7(unixMs: number, random: Uint8Array): string {
  if (!Number.isInteger(unixMs) || unixMs < 0 || unixMs > MAX_UNIX_MS) {
    throw new RangeError('uuidV7: the time must be a whole number of milliseconds in 48 bits');
  }
  // A Uint8Array only: an array or another typed array would pass a length check and lay
  // out the wrong bits, and a string or null would fail later with a different error.
  if (!(random instanceof Uint8Array) || random.length !== RANDOM_BYTES) {
    throw new RangeError('uuidV7: exactly 10 random bytes in a Uint8Array are required');
  }

  const time = unixMs.toString(16).padStart(12, '0');
  const rand = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // Variant `10`: the top two bits of the nibble are replaced, the low two are random.
  const variant = (0x8 | (parseInt(rand.charAt(4), 16) & 0x3)).toString(16);

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${rand.slice(1, 4)}`,
    `${variant}${rand.slice(5, 8)}`,
    rand.slice(8, 20),
  ].join('-');
}
