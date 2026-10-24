import type { MarketId, Population } from '@mondapac-drive/shared-kernel';

/**
 * The session cookie (identity design 6.4; platform-foundations I3): a `__Host-` cookie,
 * `Secure`, `HttpOnly`, `Path=/`, no `Domain`; `SameSite=Lax`, `Strict` for admins. Its name
 * ends with the population and the Market code, so sessions of two populations
 * never share a name, and sessions of two Markets never share a name.
 *
 * Open (spike 5, D2): a `__Host-` cookie needs a secure context, so a panel served over plain
 * `http` other than `localhost` (Safari included) cannot store it. The name and attributes stay
 * as designed until the front tier is decided.
 */
export function sessionCookieName(population: Population, marketId: MarketId): string {
  return `__Host-session-${population}-${marketId}`;
}

/** Only the admin population signs in with a cookie (see `CREDENTIAL_TRANSPORT`). */
const SAME_SITE: Readonly<Record<Population, 'Lax' | 'Strict'>> = Object.freeze({
  admin: 'Strict',
  merchant: 'Strict',
  courier: 'Strict',
});

/** The attributes every session cookie carries, set or cleared. */
function attributes(population: Population): string {
  return `Path=/; Secure; HttpOnly; SameSite=${SAME_SITE[population]}`;
}

/** A session token travels only in this alphabet (identity design 6.2: base64url). */
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The `Set-Cookie` value that stores a session token. `maxAgeSeconds` makes it persistent
 * (a "keep me signed in"); `null` makes it a session cookie (identity
 * design 6.1). The token is never in a response body for the cookie transport.
 */
export function sessionCookie(
  population: Population,
  marketId: MarketId,
  token: string,
  maxAgeSeconds: number | null,
): string {
  if (!COOKIE_VALUE.test(token)) throw new TypeError('sessionCookie: malformed token');
  if (maxAgeSeconds !== null && !(Number.isInteger(maxAgeSeconds) && maxAgeSeconds > 0)) {
    throw new TypeError('sessionCookie: Max-Age must be a positive whole number of seconds');
  }
  const maxAge = maxAgeSeconds === null ? '' : `; Max-Age=${maxAgeSeconds}`;
  return `${sessionCookieName(population, marketId)}=${token}${maxAge}; ${attributes(population)}`;
}

/** The `Set-Cookie` value that clears a session cookie (sign-out, `session.invalid`). */
export function clearedSessionCookie(population: Population, marketId: MarketId): string {
  return `${sessionCookieName(population, marketId)}=; Max-Age=0; ${attributes(population)}`;
}

/** What the request carries under one cookie name. */
export type CookieRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'one'; readonly value: string }
  /** The name appears more than once (HF7: cookie tossing), or its value is malformed. */
  | { readonly kind: 'refused' };

/**
 * Reads one cookie strictly (identity design 6.4, HF7): only the exact name, case-sensitive;
 * a name that appears twice in the request, across every `Cookie` header line (Node joins them
 * with `; `), is refused, and so is a value outside the token alphabet. Other cookies are
 * ignored and never parsed further.
 */
export function readCookie(header: string | string[] | undefined, name: string): CookieRead {
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const values: string[] = [];
  for (const line of lines) {
    for (const pair of line.split(';')) {
      const equals = pair.indexOf('=');
      const key = (equals === -1 ? pair : pair.slice(0, equals)).trim();
      if (key === name) values.push(equals === -1 ? '' : pair.slice(equals + 1).trim());
    }
  }
  if (values.length === 0) return { kind: 'absent' };
  if (values.length > 1) return { kind: 'refused' };
  const value = values[0]!;
  return COOKIE_VALUE.test(value) ? { kind: 'one', value } : { kind: 'refused' };
}
