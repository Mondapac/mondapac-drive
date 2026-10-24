import { HttpException } from '@nestjs/common';

/**
 * A field the request got wrong; never its value (identity design 5.2). The shape of
 * application's FieldProblem, which an entry point may not import (use-cases-are-the-only-way-in).
 */
interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/** At most this many unknown field names are echoed, then one {@link MORE_FIELDS} marker. */
export const MAX_ECHOED_UNKNOWN_FIELDS = 10;
/** The path of the marker that stands for the unknown fields not echoed (U+2026). */
export const MORE_FIELDS = '…';
const MAX_ECHOED_NAME_CODE_POINTS = 64;
/** Control and format characters (bidi overrides, zero-width marks...) and lone surrogates. */
const UNSAFE_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/**
 * A client-supplied field name made safe to echo (Hassan L2): lone surrogates and control or
 * format characters become U+FFFD, and the name is cut to 64 code points (never inside a
 * surrogate pair).
 */
export function echoedFieldName(name: string): string {
  return Array.from(name.replace(UNSAFE_IN_NAME, '�'))
    .slice(0, MAX_ECHOED_NAME_CODE_POINTS)
    .join('');
}

/**
 * Checks the shape of a closed JSON body of string fields (identity design 5.2): every named
 * field present and a string, no other field; values are never echoed, and an unknown field's
 * name only after {@link echoedFieldName}.
 */
export function parseStringFields<const F extends string>(
  body: unknown,
  fields: readonly F[],
): Readonly<Record<F, string>> | readonly FieldProblem[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [{ path: '', code: 'type' }];
  }
  const record = body as Record<string, unknown>;
  // An unknown field is refused, never stored.
  const unknown = Object.keys(record)
    .filter((key) => !(fields as readonly string[]).includes(key))
    .sort();
  const problems: FieldProblem[] = unknown
    .slice(0, MAX_ECHOED_UNKNOWN_FIELDS)
    .map((key) => ({ path: echoedFieldName(key), code: 'unknown-field' }));
  if (unknown.length > MAX_ECHOED_UNKNOWN_FIELDS) {
    problems.push({ path: MORE_FIELDS, code: 'unknown-field' });
  }
  for (const field of fields) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    if (value === undefined) problems.push({ path: field, code: 'required' });
    else if (typeof value !== 'string') problems.push({ path: field, code: 'type' });
  }
  if (problems.length > 0) return problems;
  return Object.fromEntries(fields.map((field) => [field, record[field] as string])) as Record<
    F,
    string
  >;
}

/** An answer in the error format of identity design 5.2: `{ statusCode, code, details? }`. */
export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The outcome code to log: a use case's code, or the code of a refusal already built. */
export const outcomeOf = (outcome: { code: string } | HttpException): string =>
  outcome instanceof HttpException
    ? (outcome.getResponse() as { code: string }).code
    : outcome.code;
