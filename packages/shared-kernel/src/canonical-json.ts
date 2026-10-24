import { err, ok } from './result';
import type { Result } from './result';

/**
 * Why {@link canonicalJson} refused a value (docs/design/domain/platform-audit.md 6.3; Hassan
 * I1). A code only: never the value, a key or a path, because the input may be a row read
 * back from the database.
 */
export interface CanonicalJsonError {
  readonly code: 'canonical-json.refused';
  readonly problem:
    | 'non-finite-number'
    | 'undefined'
    | 'bigint'
    | 'unsupported-type'
    | 'cycle'
    | 'lone-surrogate'
    | 'too-deep';
}

/**
 * The deepest nesting of arrays and objects {@link canonicalJson} accepts; the top-level
 * array or object is level 1 (Hassan M2 on slice 6a). Deeper input is refused with
 * `too-deep` before the walk can exhaust the call stack: an audit side holds at most a list
 * inside an object, and the database cap (8 192 bytes) allows about 4 000 levels.
 */
export const MAX_CANONICAL_JSON_DEPTH = 64;

// In a `u` regular expression a well-formed surrogate pair is one code point, so only a lone
// surrogate is of category Cs.
const LONE_SURROGATE = /\p{Cs}/u;

/** Internal: unwinds the walk; {@link canonicalJson} turns it into its `err` value. */
class Refusal extends Error {
  override readonly name = 'CanonicalJsonRefusal';
  constructor(readonly problem: CanonicalJsonError['problem']) {
    super(problem);
  }
}

function serialiseString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new Refusal('lone-surrogate');
  // RFC 8785 3.2.2.2: the string serialisation of ECMAScript JSON.stringify.
  return JSON.stringify(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function serialise(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return serialiseString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Refusal('non-finite-number');
      // RFC 8785 3.2.2.3: the number serialisation of ECMAScript; -0 is written as 0.
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      throw new Refusal('undefined');
    case 'bigint':
      throw new Refusal('bigint');
    case 'object':
      break;
    default:
      // function, symbol
      throw new Refusal('unsupported-type');
  }
  if (value === null) return 'null';
  if (ancestors.has(value)) throw new Refusal('cycle');
  // `ancestors` holds exactly the arrays and objects above this one.
  if (ancestors.size >= MAX_CANONICAL_JSON_DEPTH) throw new Refusal('too-deep');

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Refusal('unsupported-type');
    ancestors.add(value);
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // A hole is an absent value, as `undefined` is.
      if (!Object.hasOwn(value, index)) throw new Refusal('undefined');
      items.push(serialise(value[index] as unknown, ancestors));
    }
    ancestors.delete(value);
    return `[${items.join(',')}]`;
  }

  // Only plain objects: no Date, Map, Set, boxed primitive or class instance; no symbol keys,
  // accessors or `toJSON`, so the output depends on the data alone.
  if (!isPlainObject(value)) throw new Refusal('unsupported-type');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Refusal('unsupported-type');
  if ('toJSON' in value) throw new Refusal('unsupported-type');
  ancestors.add(value);
  // RFC 8785 3.2.3: properties sorted by their names as arrays of UTF-16 code units, which is
  // the default order of Array.prototype.sort on strings.
  const keys = Object.keys(value).sort();
  const members: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Refusal('unsupported-type');
    }
    members.push(`${serialiseString(key)}:${serialise(descriptor.value, ancestors)}`);
  }
  ancestors.delete(value);
  return `{${members.join(',')}}`;
}

/**
 * The canonical JSON text of `value`: RFC 8785 (JSON Canonicalization Scheme), in pure
 * TypeScript (docs/design/domain/platform-audit.md 6.3). Numbers and strings are written
 * exactly as `JSON.stringify` writes them, with `-0` as `0`; object properties are sorted by
 * UTF-16 code unit; there is no whitespace. Hash the UTF-8 bytes of the result.
 *
 * Refused (Hassan I1), as a value and never by throwing: non-finite numbers, `undefined`
 * (array holes included) and `BigInt`; anything but plain objects, arrays and primitives
 * (`Date`, `Map`, `Set`, class instances, functions, symbols, objects with `toJSON`, symbol
 * keys or accessors); cycles; strings and keys with a lone surrogate; nesting deeper than
 * {@link MAX_CANONICAL_JSON_DEPTH}. A value shared by two branches is not a cycle.
 */
export function canonicalJson(value: unknown): Result<string, CanonicalJsonError> {
  try {
    return ok(serialise(value, new Set()));
  } catch (error) {
    if (error instanceof Refusal) {
      return err({ code: 'canonical-json.refused', problem: error.problem });
    }
    throw error;
  }
}
