/**
 * A refusal of the gate (identity design 5.2, "Answers and HTTP status"). Codes, never message
 * text; `details` is a closed object per code. The same value goes to the caller of
 * `UseCase.execute` and, through the controller, into the error body `{ statusCode, code,
 * details? }`.
 */
export type AccessDenied =
  | { readonly code: 'access.unauthenticated' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export type AccessDeniedCode = AccessDenied['code'];

/** The HTTP status of each refusal (identity design 5.2). */
export const ACCESS_DENIED_STATUS: Readonly<Record<AccessDeniedCode, number>> = Object.freeze({
  'access.unauthenticated': 401,
  'access.denied': 403,
  'access.unavailable': 503,
});

export const UNAUTHENTICATED: AccessDenied = Object.freeze({ code: 'access.unauthenticated' });
export const DENIED: AccessDenied = Object.freeze({ code: 'access.denied' });
export const UNAVAILABLE: AccessDenied = Object.freeze({ code: 'access.unavailable' });
