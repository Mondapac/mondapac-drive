import { timingSafeEqual } from 'node:crypto';
import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
  type PendingInvitation,
} from '../../application/ports/invitation.repository';
import {
  INVITATION_KINDS,
  INVITATION_STATES,
  Invitation,
  type InvitationKind,
  type InvitationState,
  type InvitationStateCode,
} from '../../domain/invitation';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toOptionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

/** The partial unique index of data design 3.10: one answer, `already-pending`. */
const PENDING_KEYS: ReadonlySet<string> = new Set(['invitations_market_id_kind_email_pending_key']);

const SELECTED = {
  id: true,
  marketId: true,
  kind: true,
  email: true,
  emailNormalized: true,
  roleId: true,
  invitedByAccountId: true,
  tokenHash: true,
  expiresAt: true,
  state: true,
  decidedAt: true,
  acceptedAccountId: true,
  version: true,
  createdAt: true,
} as const;

interface SelectedRow {
  readonly id: string;
  readonly marketId: string;
  readonly kind: string;
  readonly email: string | null;
  readonly emailNormalized: string | null;
  readonly roleId: string;
  readonly invitedByAccountId: string | null;
  readonly tokenHash: Uint8Array | null;
  readonly expiresAt: Date | null;
  readonly state: string;
  readonly decidedAt: Date | null;
  readonly acceptedAccountId: string | null;
  readonly version: number;
  readonly createdAt: Date;
}

/**
 * {@link InvitationRepository} on `identity.invitations` (data design 3.10). Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where` (P 4); single
 * statements, never nested (C10). The invited address is personal data and the token hash a
 * secret: neither is logged, and a unique violation is mapped to its domain error without any
 * driver detail (I15).
 */
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'Invitation'>): Promise<Invitation | null> {
    const row = await this.prisma.tx(market).identityInvitation.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<Invitation | null> {
    const presented = Uint8Array.from(tokenHash);
    const row = await this.prisma.tx(market).identityInvitation.findFirst({
      where: { marketId: market.marketId, tokenHash: presented },
      select: SELECTED,
    });
    if (
      row === null ||
      row.tokenHash === null ||
      row.tokenHash.length !== presented.length ||
      !timingSafeEqual(row.tokenHash, presented)
    ) {
      return null;
    }
    return restore(row);
  }

  async findPendingFor(
    market: MarketContext,
    kind: InvitationKind,
    emailNormalized: string,
  ): Promise<Invitation | null> {
    // On the partial unique key `invitations_market_id_kind_email_pending_key`.
    const row = await this.prisma.tx(market).identityInvitation.findFirst({
      where: { marketId: market.marketId, kind, emailNormalized, state: 'pending' },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async pendingInvitations(
    market: MarketContext,
    kind: InvitationKind,
    after: Id<'Invitation'> | null,
    limit: number,
  ): Promise<PendingInvitation[]> {
    // The predicate of the partial key `invitations_market_id_kind_email_pending_key`, so the
    // planner can use it. A summary: never `token_hash` (Hassan L1 on PR #196).
    const rows = await this.prisma.tx(market).identityInvitation.findMany({
      where: {
        marketId: market.marketId,
        kind,
        state: 'pending',
        ...(after === null ? {} : { id: { gt: after } }),
      },
      select: {
        id: true,
        email: true,
        roleId: true,
        invitedByAccountId: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'Invitation'>,
      state: 'pending',
      // `invitations_email_pending_check`: a pending invitation holds its address.
      email: row.email ?? '',
      roleId: row.roleId as Id<'Role'>,
      invitedByAccountId: row.invitedByAccountId as Id<'Account'> | null,
      expiresAt: toOptionalInstant(row.expiresAt),
      createdAt: toInstant(row.createdAt),
    }));
  }

  async add(market: MarketContext, invitation: Invitation): Promise<void> {
    const state = invitation.state;
    if (invitation.persistedVersion !== null) {
      throw new Error('add: the invitation is already stored');
    }
    try {
      await this.prisma.tx(market).identityInvitation.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: state.kind,
          roleId: state.roleId,
          invitedByAccountId: state.invitedByAccountId,
          createdAt: toDate(state.createdAt),
          ...columns(state),
        },
        select: { id: true },
      });
    } catch (error) {
      const constraint = this.prisma.violatedConstraint(error);
      if (constraint !== null && PENDING_KEYS.has(constraint)) {
        throw new InvitationAlreadyPendingError();
      }
      throw error;
    }
  }

  async save(market: MarketContext, invitation: Invitation): Promise<void> {
    const state = invitation.state;
    const expected = invitation.persistedVersion;
    if (expected === null) throw new Error('save: the invitation was never stored; use add');
    if (state.version === expected) return;
    const { count } = await this.prisma.tx(market).identityInvitation.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: columns(state),
    });
    if (count !== 1) throw new StaleAggregateError('invitation', state.id);
  }

  async purge(
    market: MarketContext,
    now: Temporal.Instant,
    decidedBefore: Temporal.Instant,
    undispatchedCreatedBefore: Readonly<Partial<Record<InvitationKind, Temporal.Instant>>> = {},
  ): Promise<number> {
    // A never-dispatched invitation (no token, so no expiry) still holds its pending keys; it
    // goes once it is older than its kind's lifetime (Ali 2026-10-08; data design 9).
    const undispatched = INVITATION_KINDS.flatMap((kind) => {
      const before = undispatchedCreatedBefore[kind];
      return before === undefined
        ? []
        : [{ state: 'pending', kind, tokenHash: null, createdAt: { lt: toDate(before) } }];
    });
    const { count } = await this.prisma.tx(market).identityInvitation.deleteMany({
      where: {
        marketId: market.marketId,
        OR: [
          { state: 'pending', expiresAt: { lt: toDate(now) } },
          { state: { in: ['accepted', 'revoked'] }, decidedAt: { lt: toDate(decidedBefore) } },
          ...undispatched,
        ],
      },
    });
    return count;
  }
}

/** The columns a save writes; kind, role and inviter never change (3.4). */
function columns(state: InvitationState) {
  return {
    email: state.email?.typed ?? null,
    emailNormalized: state.email?.normalized ?? null,
    tokenHash: state.tokenHash === null ? null : Uint8Array.from(state.tokenHash),
    expiresAt: toOptionalDate(state.expiresAt),
    state: state.state,
    decidedAt: toOptionalDate(state.decidedAt),
    acceptedAccountId: state.acceptedAccountId,
    version: state.version,
  };
}

function restore(row: SelectedRow): Invitation {
  const marketId = parseMarketId(row.marketId);
  if (
    !marketId.ok ||
    !(INVITATION_KINDS as readonly string[]).includes(row.kind) ||
    !(INVITATION_STATES as readonly string[]).includes(row.state) ||
    (row.email === null) !== (row.emailNormalized === null)
  ) {
    throw new Error('identity.invitations: a stored invitation is malformed');
  }
  return Invitation.restore({
    id: row.id as Id<'Invitation'>,
    marketId: marketId.value,
    kind: row.kind as InvitationKind,
    email:
      row.email === null || row.emailNormalized === null
        ? null
        : { typed: row.email, normalized: row.emailNormalized },
    roleId: row.roleId as Id<'Role'>,
    invitedByAccountId: row.invitedByAccountId as Id<'Account'> | null,
    tokenHash: row.tokenHash === null ? null : Uint8Array.from(row.tokenHash),
    expiresAt: toOptionalInstant(row.expiresAt),
    state: row.state as InvitationStateCode,
    decidedAt: toOptionalInstant(row.decidedAt),
    acceptedAccountId: row.acceptedAccountId as Id<'Account'> | null,
    createdAt: toInstant(row.createdAt),
    version: row.version,
  });
}
