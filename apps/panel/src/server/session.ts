import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverGet } from './server-fetch.ts';

export interface AdminSession {
  readonly accountId: string;
  readonly roleId: string;
  readonly permissionKeys: readonly string[];
  readonly secondFactorActive: boolean;
  /** The previous successful sign-in (ISO 8601, UTC), or null when none is on record. */
  readonly lastSignInAt: string | null;
  readonly email: string;
  readonly displayName: string;
  /** The holder's own IANA time zone, or null when none was chosen. */
  readonly timezone: string | null;
  /** The holder's panel language code, or null when none was chosen. */
  readonly locale: string | null;
  readonly csrfToken: string;
}

export type SessionRead =
  | { readonly kind: 'signed-in'; readonly session: AdminSession }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' };

/**
 * Reads the actor summary for the page being rendered, with the same mapping and header code as
 * the relay (ADR-0034 decision 4). It never sets a cookie: a rejected session is cleared through
 * the relay by `/session-ended`.
 */
export async function readSession(): Promise<SessionRead> {
  const read = await serverGet<AdminSession>('identity/admin/session');
  if (read.kind === 'ok') return { kind: 'signed-in', session: read.body };
  return read.kind === 'signed-out' ? { kind: 'signed-out' } : { kind: 'unavailable' };
}

/**
 * The session for a page that needs one: signed-out visitors are sent to sign-in (through
 * `/session-ended` when the browser held a cookie the API rejected). `unavailable` is for the
 * page to show as an error.
 */
export async function requireSession(): Promise<
  { readonly kind: 'ok'; readonly session: AdminSession } | { readonly kind: 'unavailable' }
> {
  const read = await readSession();
  if (read.kind === 'signed-out') {
    const jar = await cookies();
    const hadSession = jar.getAll().some((c) => c.name.startsWith('__Host-session-admin-'));
    redirect(hadSession ? '/session-ended' : '/sign-in');
  }
  return read.kind === 'signed-in'
    ? { kind: 'ok', session: read.session }
    : { kind: 'unavailable' };
}
