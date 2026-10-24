import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { Invitation, InvitationKind } from '../../domain/invitation';

/**
 * A pending invitation as a team list reads it (slice 8c): no token hash, no decision fields. The invited address is personal data, never logged.
 */
export interface PendingInvitation {
  readonly id: Id<'Invitation'>;
  readonly state: 'pending';
  /** As typed. */
  readonly email: string;
  readonly roleId: Id<'Role'>;
  readonly invitedByAccountId: Id<'Account'> | null;
  readonly expiresAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

/**
 * The invitations of `identity` (identity design 3.4; data design 3.10). Every method runs in
 * the caller's open unit and takes the `MarketContext` only. A token is never passed in, only
 * its SHA-256. The invited address is personal data: it is never logged here.
 */
export interface InvitationRepository {
  findById(market: MarketContext, id: Id<'Invitation'>): Promise<Invitation | null>;

  /** The invitation whose stored hash is this one, in this Market, or null. */
  findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<Invitation | null>;

  /**
   * The pending invitation of this kind for this address, or null: the row the partial unique
   * key `invitations_market_id_kind_email_pending_key` allows at most one of. An issue reads it
   * to replace it when stale (M7; item G).
   */
  findPendingFor(
    market: MarketContext,
    kind: InvitationKind,
    emailNormalized: string,
  ): Promise<Invitation | null>;

  /**
   * Up to `limit` pending invitations of this kind in this Market, expired ones included, whose
   * id is greater than `after` (all when null), by id: the open invitations of a team list, as a
   * summary without the token hash (Hassan L1 on PR #196).
   */
  pendingInvitations(
    market: MarketContext,
    kind: InvitationKind,
    after: Id<'Invitation'> | null,
    limit: number,
  ): Promise<PendingInvitation[]>;

  /**
   * Stores a new invitation. A pending invitation of the same kind for the same address (the
   * partial unique index of data design 3.10) throws {@link InvitationAlreadyPendingError}.
   */
  add(market: MarketContext, invitation: Invitation): Promise<void>;

  /**
   * Stores the changes of a loaded invitation if its version is still the one read; otherwise
   * throws `StaleAggregateError` (platform persistence 10).
   */
  save(market: MarketContext, invitation: Invitation): Promise<void>;

  /**
   * The hourly purge (data design 9): pending invitations whose expiry is before `now`, decided
   * ones whose decision is before `decidedBefore`, and (Ali 2026-10-08) pending invitations never
   * dispatched (no token) created before the cut-off given for their kind, which is `now` minus
   * that kind's lifetime. A kind with no cut-off is left alone. Answers how many were deleted.
   */
  purge(
    market: MarketContext,
    now: Temporal.Instant,
    decidedBefore: Temporal.Instant,
    undispatchedCreatedBefore?: Readonly<Partial<Record<InvitationKind, Temporal.Instant>>>,
  ): Promise<number>;
}

/** Nest token of the {@link InvitationRepository}. */
export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

/** One pending invitation per address and kind (3.4). */
export class InvitationAlreadyPendingError extends Error {
  override readonly name = 'InvitationAlreadyPendingError';
  readonly code = 'invitation.already-pending';
  constructor() {
    super('identity: an invitation for this address and kind is already pending');
  }
}
