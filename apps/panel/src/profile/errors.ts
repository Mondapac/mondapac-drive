import type { ApiFailure } from '../api/client.ts';

/** A message key under `profile.error`, and the form field it belongs to (null: the whole form). */
export interface Problem {
  readonly key: string;
  readonly field: 'name' | 'timezone' | 'current' | 'new' | 'code' | null;
  readonly values?: Readonly<Record<string, number>>;
}

const WHOLE_FORM: Readonly<Record<string, string>> = {
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'second-factor.locked': 'code-locked',
};

/** What a failed call says about the whole form: a wait, a refusal, or the service being away. */
function formProblem(failure: ApiFailure): Problem {
  if (failure.code === 'request.throttled') {
    const seconds = failure.details?.retryAfterSeconds ?? 60;
    return {
      key: 'throttled',
      field: null,
      values: { minutes: Math.max(1, Math.ceil(seconds / 60)) },
    };
  }
  const named = WHOLE_FORM[failure.code];
  if (named !== undefined) return { key: named, field: null };
  if (failure.status === 0) return { key: 'network', field: null };
  return { key: failure.status === 503 ? 'unavailable' : 'unknown', field: null };
}

/** The problem of a refused display-name change. */
export function nameProblemOf(failure: ApiFailure): Problem {
  if (failure.code === 'validation.failed') {
    const code = failure.details?.fields?.find((f) => f.path === 'displayName')?.code;
    return { key: code === 'characters' ? 'name-characters' : 'name-length', field: 'name' };
  }
  return formProblem(failure);
}

/** The problem of a refused time zone and language change. */
export function preferencesProblemOf(failure: ApiFailure): Problem {
  if (failure.code === 'validation.failed') return { key: 'prefs-invalid', field: 'timezone' };
  return formProblem(failure);
}

/** The problem of a refused password change, with the rule values the message may need. */
export function passwordProblemOf(
  failure: ApiFailure,
  limits: { readonly min: number; readonly max: number },
): Problem {
  switch (failure.code) {
    case 'password.current-incorrect':
      return { key: 'current-incorrect', field: 'current' };
    case 'password.rejected': {
      const rule = failure.details?.rule;
      const key = rule === 'common' || rule === 'contains-identity' ? `new-${rule}` : 'new-length';
      return { key, field: 'new', values: limits };
    }
    case 'second-factor.invalid':
      return { key: 'code-rejected', field: 'code' };
    case 'validation.failed': {
      const path = failure.details?.fields?.[0]?.path;
      if (path === 'code') return { key: 'code-required', field: 'code' };
      if (path === 'currentPassword') return { key: 'current-incorrect', field: 'current' };
      return { key: 'new-length', field: 'new', values: limits };
    }
    default:
      return formProblem(failure);
  }
}

/** The problem of a refused "sign out of all other devices". */
export function sessionsProblemOf(failure: ApiFailure): Problem {
  return formProblem(failure);
}
