/** One digits-only postcode interval, both ends the same length so the compare is numeric. */
export interface PostcodeInterval {
  readonly length: number;
  readonly low: number;
  readonly high: number;
}

const RANGE = /^(\d{1,10})-(\d{1,10})$/u;
const EXACT = /^[A-Z0-9]{1,10}$/u;

export class InvalidPostcodeEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPostcodeEntryError';
  }
}

export type PostcodeEntry =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'interval'; readonly interval: PostcodeInterval };

/** Upper-case ASCII without whitespace, so "sw1a 1aa" and "SW1A1AA" are the same postcode. */
export function normalisePostcode(postcode: string): string {
  return postcode.replace(/\s+/gu, '').toUpperCase();
}

/**
 * The one grammar for a postcode entry in configuration (ServiceArea files and Market
 * timezone exceptions): an exact postcode of ASCII letters and digits, or a digits-only range
 * whose ends have the same length, low to high. A hyphen therefore always means a range; a
 * Market whose real postcodes contain a hyphen cannot list them until the grammar grows.
 */
export function parsePostcodeEntry(entry: string): PostcodeEntry {
  const value = normalisePostcode(entry);
  const range = RANGE.exec(value);
  if (range !== null) {
    const [, from = '', to = ''] = range;
    if (from.length !== to.length || Number(from) > Number(to)) {
      throw new InvalidPostcodeEntryError(
        `range "${entry}" must have ends of the same length, low to high` +
          ' (a hyphenated postcode cannot be listed as an exact entry)',
      );
    }
    return {
      kind: 'interval',
      interval: { length: from.length, low: Number(from), high: Number(to) },
    };
  }
  if (!EXACT.test(value)) {
    throw new InvalidPostcodeEntryError(
      `"${entry}" is not a postcode (ASCII letters and digits) or a digit range`,
    );
  }
  if (/^\d+$/u.test(value)) {
    return {
      kind: 'interval',
      interval: { length: value.length, low: Number(value), high: Number(value) },
    };
  }
  return { kind: 'exact', value };
}

export function intervalsOverlap(a: PostcodeInterval, b: PostcodeInterval): boolean {
  return a.length === b.length && a.low <= b.high && b.low <= a.high;
}

export interface ParsedPostcodes {
  readonly intervals: readonly PostcodeInterval[];
  readonly exact: ReadonlySet<string>;
}

export function parsePostcodeEntries(entries: readonly string[]): ParsedPostcodes {
  const intervals: PostcodeInterval[] = [];
  const exact = new Set<string>();
  for (const entry of entries) {
    const parsed = parsePostcodeEntry(entry);
    if (parsed.kind === 'exact') exact.add(parsed.value);
    else intervals.push(parsed.interval);
  }
  return { intervals, exact };
}

/** True when two parsed sets claim a common postcode. */
export function postcodesClash(a: ParsedPostcodes, b: ParsedPostcodes): boolean {
  return (
    [...a.exact].some((value) => b.exact.has(value)) ||
    a.intervals.some((x) => b.intervals.some((y) => intervalsOverlap(x, y)))
  );
}
