/**
 * The outcome of an operation that can fail in an expected way. Expected failures are
 * values; exceptions remain for programmer errors and infrastructure failures.
 *
 * `E` is a closed union whose members carry a stable `code`. An error reaches logs and API
 * answers, so it never holds personal data, free text or message text.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
