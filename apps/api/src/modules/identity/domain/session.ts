import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, Population } from '@mondapac-drive/shared-kernel';
import type { DeviceCode } from './device';

/** Where a session's token travels; a session is bound to one (identity design 6.2). */
export type SessionTransport = 'cookie' | 'bearer' | 'api-key';

/** A population's lifetimes, fixed on the session at creation (identity design 6.1; M2). */
export interface SessionLifetime {
  readonly idleTimeoutSeconds: number;
  readonly absoluteLifetimeSeconds: number;
}

/**
 * A session (identity design 3.5; data design 3.4). No version: revocation is a set-based
 * update, and expiry is decided at read time from the `Clock`, never stored. The token is never
 * part of it; only its hash is stored, by the repository.
 */
export interface Session {
  readonly id: Id<'Session'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  /** Set if and only if the population is `merchant` (`sessions_merchant_id_check`). */
  readonly merchantId: Id<'Merchant'> | null;
  readonly transport: SessionTransport;
  /** The name of a merchant API key; set if and only if the transport is `api-key`. */
  readonly label: string | null;
  /** The coarse device it was opened on (profile package 4); null when unknown. */
  readonly device: DeviceCode | null;
  readonly createdAt: Temporal.Instant;
  readonly lastSeenAt: Temporal.Instant;
  readonly idleTimeoutSeconds: number;
  readonly absoluteExpiresAt: Temporal.Instant;
  readonly revokedAt: Temporal.Instant | null;
  readonly revokedReason: string | null;
}

/** The longest name of a merchant API key (`sessions.label` is VarChar(64)). */
export const API_KEY_LABEL_MAX = 64;

/** `lastSeenAt` is written at most once a minute per session (identity design 6.1). */
export const LAST_SEEN_INTERVAL_SECONDS = 60;

/** A session refused a lifetime that cannot hold (a configuration error caught at boot too). */
export class SessionLifetimeError extends Error {
  override readonly name = 'SessionLifetimeError';
  constructor() {
    super('A session needs a positive idle timeout no longer than its absolute lifetime');
  }
}

/**
 * Opens a session at the end of a successful sign-in (identity design 3.5, 6.3 step 7). Both
 * lifetimes are fixed now; the absolute expiry can never be extended.
 */
export function openSession(input: {
  readonly id: Id<'Session'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  /** Required for, and only for, the merchant population (`sessions_merchant_id_check`). */
  readonly merchantId?: Id<'Merchant'> | null;
  readonly transport: SessionTransport;
  /** Required for, and only for, an API key (`sessions_label_check`). */
  readonly label?: string | null;
  /** The coarse device of the sign-in request; null when it sent no User-Agent. */
  readonly device?: DeviceCode | null;
  readonly lifetime: SessionLifetime;
  readonly now: Temporal.Instant;
}): Session {
  const { lifetime, now } = input;
  if (
    !Number.isInteger(lifetime.idleTimeoutSeconds) ||
    !Number.isInteger(lifetime.absoluteLifetimeSeconds) ||
    lifetime.idleTimeoutSeconds <= 0 ||
    lifetime.idleTimeoutSeconds > lifetime.absoluteLifetimeSeconds
  ) {
    throw new SessionLifetimeError();
  }
  const merchantId = input.merchantId ?? null;
  if ((input.population === 'merchant') !== (merchantId !== null)) {
    // A merchant session carries its merchant, and only a merchant session has one.
    throw new TypeError('openSession: a merchant id is required for, and only for, a merchant');
  }
  const label = input.label ?? null;
  if ((input.transport === 'api-key') !== (label !== null)) {
    throw new TypeError('openSession: a label is required for, and only for, an API key');
  }
  if (label !== null && (label.length < 1 || label.length > API_KEY_LABEL_MAX)) {
    throw new TypeError('openSession: an API key label is 1 to 64 characters');
  }
  return Object.freeze({
    id: input.id,
    marketId: input.marketId,
    accountId: input.accountId,
    population: input.population,
    merchantId,
    transport: input.transport,
    label,
    device: input.device ?? null,
    createdAt: now,
    lastSeenAt: now,
    idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
    absoluteExpiresAt: now.add({ seconds: lifetime.absoluteLifetimeSeconds }),
    revokedAt: null,
    revokedReason: null,
  });
}

/**
 * Whether a session may authenticate a request at `now` (identity design 3.5, 6.2): not revoked,
 * before its absolute expiry and within its idle timeout of the last request. The instant of an
 * expiry is already expired.
 */
export function sessionIsLive(session: Session, now: Temporal.Instant): boolean {
  if (session.revokedAt !== null) return false;
  if (Temporal.Instant.compare(now, session.absoluteExpiresAt) >= 0) return false;
  const idleEnds = session.lastSeenAt.add({ seconds: session.idleTimeoutSeconds });
  return Temporal.Instant.compare(now, idleEnds) < 0;
}

/** Whether a request at `now` should write `lastSeenAt` (at most once a minute). */
export function lastSeenIsDue(session: Session, now: Temporal.Instant): boolean {
  const due = session.lastSeenAt.add({ seconds: LAST_SEEN_INTERVAL_SECONDS });
  return Temporal.Instant.compare(now, due) >= 0;
}

/**
 * The code of a revocation (data design 3.4: a code, checked by the table's pattern): sign-out;
 * a password reset (every session of the account); a password change (every other session);
 * slice 7b: a second factor activated or replaced (every other session, D), or reset (every
 * session, 3.6).
 */
export type SessionRevokedReason =
  | 'sign-out'
  | 'password-reset'
  | 'password-changed'
  | 'second-factor-activated'
  | 'second-factor-replaced'
  | 'second-factor-reset'
  /** An admin disabled the account (3.1; slice 8b). */
  | 'account-disabled'
  /** An admin revoked a merchant API key. */
  | 'api-key-revoked'
  /** Every API key of the merchant: the merchant was suspended. */
  | 'merchant-suspended'
  /** The holder signed out of every other device from the profile (profile package 4). */
  | 'signed-out-elsewhere';
