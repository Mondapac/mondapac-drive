import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac-drive/shared-kernel';
import type { EmailAddress } from './email-address';
import {
  INVITATION_KINDS,
  InvitationAccepted,
  InvitationIssued,
  InvitationRevoked,
} from './events';

/** The kinds: admin (an operator or dispatcher) and courier. */
export { INVITATION_KINDS };
export type InvitationKind = (typeof INVITATION_KINDS)[number];

/** Stored states (data design 3.10); `expired` is never stored, it is read from the clock. */
export const INVITATION_STATES = ['pending', 'accepted', 'revoked'] as const;
export type InvitationStateCode = (typeof INVITATION_STATES)[number];

/** Where an invitation stands at an instant (identity design 3.4). */
export type InvitationStatus = InvitationStateCode | 'expired';

/** The state of an {@link Invitation} (identity design 2.1, 3.4; data design 3.10). */
export interface InvitationState {
  readonly id: Id<'Invitation'>;
  readonly marketId: MarketId;
  readonly kind: InvitationKind;
  /** Personal; only while pending (data design 4: never after a decision). */
  readonly email: EmailAddress | null;
  /** May dangle by design (R12): acceptance re-checks that the role exists. */
  readonly roleId: Id<'Role'>;
  /** Null for the first-admin routine (D 7.4, HF5 (b)). */
  readonly invitedByAccountId: Id<'Account'> | null;
  /** SHA-256 of the token sent; null until dispatch. The token itself is never held. */
  readonly tokenHash: Uint8Array | null;
  /** Set with the hash at dispatch; a re-send replaces both. */
  readonly expiresAt: Temporal.Instant | null;
  readonly state: InvitationStateCode;
  readonly decidedAt: Temporal.Instant | null;
  readonly acceptedAccountId: Id<'Account'> | null;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
}

/**
 * Where an invitation stands at `now` (3.4): its stored state, or `expired` for a pending one at
 * or past the expiry of its last mail. The one rule of `Invitation.statusAt` and of a read that
 * holds only these fields, never the token hash (the admin team list, slice 8c).
 */
export function invitationStatusAt(
  invitation: Pick<InvitationState, 'state' | 'expiresAt'>,
  now: Temporal.Instant,
): InvitationStatus {
  const { state, expiresAt } = invitation;
  if (state !== 'pending') return state;
  return expiresAt !== null && Temporal.Instant.compare(now, expiresAt) >= 0
    ? 'expired'
    : 'pending';
}

/**
 * Whether a re-send is accepted at `now` (Mohammad C2): pending, and `now` before `createdAt`
 * plus the kind's lifetime. The one rule of `Invitation.reissuableAt` and `reissue`, and of the
 * admin team list's re-send hint (slice 8c).
 */
export function invitationReissuableAt(
  invitation: Pick<InvitationState, 'state' | 'createdAt'>,
  now: Temporal.Instant,
  lifetimeMinutes: number,
): boolean {
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
    throw new RangeError('reissue: a positive whole lifetime in minutes is required');
  }
  if (invitation.state !== 'pending') return false;
  const cutoff = invitation.createdAt.add({ minutes: lifetimeMinutes });
  return Temporal.Instant.compare(now, cutoff) < 0;
}

/** An invitation that cannot be used now: one answer for every cause (8.6 row 1). */
export type InvitationRejected = { readonly code: 'invitation.rejected' };
const REJECTED: InvitationRejected = Object.freeze({ code: 'invitation.rejected' });

/** An invitation that would break an invariant of 3.10: a programmer error, never a user's. */
export class InvitationInvariantError extends Error {
  override readonly name = 'InvitationInvariantError';
  constructor(detail: string) {
    super(`identity.invitations: ${detail}`);
  }
}

/**
 * The `Invitation` aggregate (identity design 2.1, 3.4; data design 3.10; R12).
 *
 * - `issue`: `pending` without a token. The token is minted at dispatch by the mail handler
 *   (6.6), which stores its hash with the expiry (`dispatch`); a re-send dispatches again, so
 *   the earlier token stops working at once.
 * - `accept`: only a dispatched, unexpired, pending invitation, once; the address is
 *   cleared with the decision, so no personal data outlives it (data design 4). The guards
 *   that need other aggregates (the role still exists, the inviter may still grant it, HF5 (b))
 *   belong to the accepting use case.
 * - `revoke`: the inviter's side withdraws a pending invitation.
 *
 * The email, role and kind never change: a different one is a new invitation (3.4).
 * Times come from the caller's `Clock`; every change raises the version by one (C5). Events
 * (8.2, slice 7b): `identity.invitation-issued.v1` at issue (the mail handler dispatches on it)
 * and `identity.invitation-accepted.v1` at acceptance; a dispatch records none.
 *
 * - `replaceableAt`: whether an issue for the same address and scope may replace this pending
 *   invitation (M7; item G, Ali 2026-10-08): it is past its expiry, or it was never dispatched
 *   and is older than its kind's lifetime, so a lost mail never blocks a new invitation.
 */
export class Invitation {
  #state: InvitationState;
  #events: PendingEvent[] = [];

  private constructor(
    state: InvitationState,
    /** The version read from the store; null for an invitation not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    Invitation.check(state);
    this.#state = Invitation.freeze(state);
  }

  static issue(input: {
    readonly id: Id<'Invitation'>;
    readonly marketId: MarketId;
    readonly kind: InvitationKind;
    readonly email: EmailAddress;
    readonly roleId: Id<'Role'>;
    readonly invitedByAccountId: Id<'Account'> | null;
    readonly now: Temporal.Instant;
  }): Invitation {
    const invitation = new Invitation(
      {
        id: input.id,
        marketId: input.marketId,
        kind: input.kind,
        email: input.email,
        roleId: input.roleId,
        invitedByAccountId: input.invitedByAccountId,
        tokenHash: null,
        expiresAt: null,
        state: 'pending',
        decidedAt: null,
        acceptedAccountId: null,
        createdAt: input.now,
        version: 1,
      },
      null,
    );
    const { id, kind } = invitation.#state;
    invitation.#events.push(
      InvitationIssued.record({
        aggregateId: id,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { invitationId: id, kind },
      }),
    );
    return invitation;
  }

  static restore(state: InvitationState): Invitation {
    return new Invitation(state, state.version);
  }

  get state(): InvitationState {
    return this.#state;
  }

  /** Events recorded since the invitation was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /**
   * Whether an issue may replace this invitation at `now` (M7; item G): it is pending and either
   * past its expiry, or never dispatched and created at least `lifetimeMinutes` (its kind's
   * lifetime) ago. A decided invitation is never in the way: its address is gone.
   */
  replaceableAt(now: Temporal.Instant, lifetimeMinutes: number): boolean {
    if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('replaceableAt: a positive whole lifetime in minutes is required');
    }
    if (this.#state.state !== 'pending') return false;
    if (this.#state.tokenHash !== null) return this.statusAt(now) === 'expired';
    const cutoff = this.#state.createdAt.add({ minutes: lifetimeMinutes });
    return Temporal.Instant.compare(now, cutoff) >= 0;
  }

  statusAt(now: Temporal.Instant): InvitationStatus {
    return invitationStatusAt(this.#state, now);
  }

  /** Whether the invitation may be accepted at `now`: dispatched, pending and unexpired. */
  usableAt(now: Temporal.Instant): boolean {
    return this.#state.tokenHash !== null && this.statusAt(now) === 'pending';
  }

  /**
   * The mail with a new token was sent (6.6): its hash and the expiry are stored, replacing an
   * earlier token (a re-send, 3.4 `pending` → `pending`). Only a pending invitation.
   */
  dispatch(
    tokenHash: Uint8Array,
    now: Temporal.Instant,
    lifetimeMinutes: number,
  ): Result<void, InvitationRejected> {
    if (this.#state.state !== 'pending') return err(REJECTED);
    if (tokenHash.length !== 32 || !Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('dispatch: a 32-byte hash and a positive whole lifetime are required');
    }
    this.change({
      tokenHash: Uint8Array.from(tokenHash),
      expiresAt: now.add({ minutes: lifetimeMinutes }),
    });
    return ok(undefined);
  }

  /** `pending` → `accepted` by the account created for it (3.4). */
  accept(accountId: Id<'Account'>, now: Temporal.Instant): Result<void, InvitationRejected> {
    if (!this.usableAt(now)) return err(REJECTED);
    this.change({
      state: 'accepted',
      decidedAt: now,
      acceptedAccountId: accountId,
      email: null,
    });
    const { id, kind, version } = this.#state;
    this.#events.push(
      InvitationAccepted.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: {
          invitationId: id,
          kind,
          accountId,
        },
      }),
    );
    return ok(undefined);
  }

  /**
   * Whether {@link reissue} would accept at `now`: pending, and `now` before `createdAt` plus the
   * kind's lifetime (Mohammad C2). Changes nothing; the admin team list's hint reads it (slice 8c).
   */
  reissuableAt(now: Temporal.Instant, lifetimeMinutes: number): boolean {
    return invitationReissuableAt(this.#state, now, lifetimeMinutes);
  }

  /**
   * `pending` → `pending`: a re-send by the inviter's side (3.4, flows E2 and F2; slice 8b). The
   * stored token is voided at once (its hash and expiry cleared), so the earlier link stops
   * working before the new mail goes; the version rises and `identity.invitation-issued.v1` is
   * recorded again, which the mail handler dispatches with a new token and a new expiry.
   *
   * Refused once `now` is at or past `createdAt` plus the kind's lifetime (Mohammad C2 on PR
   * #187): the cleared token would make it a never-dispatched invitation that item G already
   * counts as stale, and `expired` → `pending` is not a transition of 3.4. The admin invites
   * again instead, which replaces it.
   */
  reissue(now: Temporal.Instant, lifetimeMinutes: number): Result<void, InvitationRejected> {
    if (!this.reissuableAt(now, lifetimeMinutes)) return err(REJECTED);
    this.change({ tokenHash: null, expiresAt: null });
    const { id, kind, version } = this.#state;
    this.#events.push(
      InvitationIssued.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { invitationId: id, kind },
      }),
    );
    return ok(undefined);
  }

  /**
   * `pending` → `revoked` (3.4); an expired pending invitation may be revoked too. Records
   * `identity.invitation-revoked.v1` (8.2; slice 8b).
   */
  revoke(now: Temporal.Instant): Result<void, InvitationRejected> {
    if (this.#state.state !== 'pending') return err(REJECTED);
    this.change({ state: 'revoked', decidedAt: now, email: null });
    const { id, kind, version } = this.#state;
    this.#events.push(
      InvitationRevoked.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { invitationId: id, kind },
      }),
    );
    return ok(undefined);
  }

  private change(fields: Partial<InvitationState>): void {
    const next = { ...this.#state, ...fields, version: this.#state.version + 1 };
    Invitation.check(next);
    this.#state = Invitation.freeze(next);
  }

  /** The CHECKs of data design 3.10, in memory: a broken invitation is never built. */
  private static check(state: InvitationState): void {
    const pending = state.state === 'pending';
    if (!(INVITATION_KINDS as readonly string[]).includes(state.kind)) {
      throw new InvitationInvariantError('unknown kind');
    }
    if (!(INVITATION_STATES as readonly string[]).includes(state.state)) {
      throw new InvitationInvariantError('unknown state');
    }
    if (pending !== (state.email !== null)) {
      throw new InvitationInvariantError('the address is held while pending, and only then');
    }
    if ((state.tokenHash === null) !== (state.expiresAt === null)) {
      throw new InvitationInvariantError('the token hash and the expiry are set together');
    }
    if (pending !== (state.decidedAt === null)) {
      throw new InvitationInvariantError('a decision instant once decided, and only then');
    }
    if ((state.state === 'accepted') !== (state.acceptedAccountId !== null)) {
      throw new InvitationInvariantError('the accepting account once accepted, and only then');
    }
    if (state.version < 1 || !Number.isInteger(state.version)) {
      throw new InvitationInvariantError('the version is a whole number from 1');
    }
  }

  private static freeze(state: InvitationState): InvitationState {
    return Object.freeze({
      ...state,
      tokenHash: state.tokenHash === null ? null : Uint8Array.from(state.tokenHash),
    });
  }
}
