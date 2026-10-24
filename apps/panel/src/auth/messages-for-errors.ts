import type { ApiFailure } from '../api/client.ts';

/** Error codes that have a message key under `identity.error` (ux 5). Others fall to `unknown`. */
const PLAIN = new Set([
  'credentials.invalid',
  'account.disabled',
  'request.csrf',
  'second-factor.locked',
  'second-factor.code-rejected',
  'second-factor.challenge-ended',
]);

export type ErrorKey = {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
} | null;

/** The message key for a failure that is about the whole form. */
export function formErrorKey(failure: ApiFailure): ErrorKey {
  const { code } = failure;
  if (code === 'request.throttled') {
    const seconds = failure.details?.retryAfterSeconds ?? 60;
    return { key: 'request.throttled', values: { minutes: Math.max(1, Math.ceil(seconds / 60)) } };
  }
  if (code === 'account.disabled') return { key: 'account.disabled.admin' };
  if (code === 'challenge.rejected') return { key: 'second-factor.challenge-ended' };
  if (code === 'second-factor.invalid') return { key: 'second-factor.code-rejected' };
  if (code === 'second-factor.locked') return { key: 'second-factor.locked' };
  if (PLAIN.has(code)) return { key: code };
  if (code === 'network') return { key: 'network' };
  return { key: 'unknown' };
}

/** Field errors of `validation.failed`, as message keys by field name. */
export function fieldErrorKeys(
  failure: ApiFailure,
  fields: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const problem of failure.details?.fields ?? []) {
    const name = problem.path;
    if (!fields.includes(name) || name in result) continue;
    if (name === 'email')
      result[name] =
        problem.code === 'required' ? 'validation.email.required' : 'validation.email.format';
    else if (name === 'password') result[name] = 'validation.password.required';
    else if (name === 'code') result[name] = 'validation.code.required';
  }
  return result;
}

/** The key for `password.rejected` and its rule (ux 5, `password.rejected.<rule>`). */
export function passwordRuleKey(failure: ApiFailure): string {
  const rule = failure.details?.rule;
  return rule === 'common' || rule === 'contains-identity'
    ? `password.rejected.${rule}`
    : 'password.rejected.length';
}
