import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { INVITATION_KINDS, type InvitationKind } from '../../domain/invitation';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleRepository } from '../ports/throttle.repository';

/** A session row leaves 30 days after its absolute expiry (data design 3.4; M6, H8). */
export const SESSION_KEPT_AFTER_EXPIRY_HOURS = 30 * 24;
/** Throttle rows whose window started more than 48 hours ago and that are not blocked (3.5). */
export const THROTTLE_KEPT_HOURS = 48;
/** Links leave a day after they were consumed or expired (data design 9; slice 3). */
export const LINK_KEPT_AFTER_SPENT_HOURS = 24;
/** At most this many one-day deletes of sign-in records per run; the next run continues. */
export const MAX_RECORD_DAYS_PER_RUN = 400;
/** Accepted and revoked invitations leave 30 days after the decision (data design 9; slice 7). */
export const INVITATION_KEPT_AFTER_DECISION_HOURS = 30 * 24;

export interface PurgeExpiredOutput {
  readonly sessions: number;
  readonly throttles: number;
  readonly signInRecords: number;
  readonly links: number;
  readonly challenges: number;
  readonly invitations: number;
}

export type PurgeExpiredFailure = { readonly code: 'access.denied' };

export interface PurgeExpiredDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly links: OneTimeLinkRepository;
  readonly challenges: SignInChallengeRepository;
  readonly invitations: InvitationRepository;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * `identity.purge-expired` (identity design 12.2; data design 3.4 to 3.6, 9): for one Market,
 * deletes only what is already invalid, so it is safe to run twice and concurrently (PN4):
 *
 * - sessions 30 days past their absolute expiry;
 * - throttle counters whose window started more than 48 hours ago and that are not blocked;
 * - sign-in records older than the Market's retention (H3: 90 days), one day of `occurred_at`
 *   per statement, from the oldest;
 * - one-time links consumed or expired for a day (slice 3);
 * - sign-in challenges past their expiry; pending invitations past their expiry; accepted and
 *   revoked invitations 30 days after the decision (slice 7); pending invitations never
 *   dispatched, once older than their kind's lifetime from Market configuration (slice 7b, Ali's
 *   ruling 4; a kind without a configured lifetime is left alone).
 *
 * Each statement runs in its own short unit. Rule `system`: run by the hourly job only.
 */
export class PurgeExpired extends UseCase<
  Record<string, never>,
  PurgeExpiredOutput,
  PurgeExpiredFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.purge-expired',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeExpiredDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeExpiredOutput, PurgeExpiredFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, sessions, throttles, records, links, clock } = this.deps;
    const now = clock.now();

    const purgedSessions = await unitOfWork.run(market, async () =>
      ok(
        await sessions.purgeExpired(
          market,
          now.subtract({ hours: SESSION_KEPT_AFTER_EXPIRY_HOURS }),
        ),
      ),
    );
    const purgedThrottles = await unitOfWork.run(market, async () =>
      ok(await throttles.purge(market, now.subtract({ hours: THROTTLE_KEPT_HOURS }), now)),
    );

    const cutoff = now.subtract({ hours: this.deps.policy.signInRecordRetentionDays(market) * 24 });
    let purgedRecords = 0;
    const oldest = await unitOfWork.run(market, async () => ok(await records.oldest(market)), {
      readOnly: true,
    });
    let from = oldest.ok ? oldest.value : null;
    for (
      let day = 0;
      from !== null && Temporal.Instant.compare(from, cutoff) < 0 && day < MAX_RECORD_DAYS_PER_RUN;
      day += 1
    ) {
      const dayEnd = from.add({ hours: 24 });
      const to = Temporal.Instant.compare(dayEnd, cutoff) < 0 ? dayEnd : cutoff;
      const start = from;
      const deleted = await unitOfWork.run(market, async () =>
        ok(await records.deleteBetween(market, start, to)),
      );
      purgedRecords += deleted.ok ? deleted.value : 0;
      from = to;
    }

    const purgedLinks = await unitOfWork.run(market, async () =>
      ok(await links.purgeSpent(market, now.subtract({ hours: LINK_KEPT_AFTER_SPENT_HOURS }))),
    );

    const purgedChallenges = await unitOfWork.run(market, async () =>
      ok(await this.deps.challenges.purgeExpired(market, now)),
    );
    // Ali's ruling 4 (slice 7b, item G): a never-dispatched pending invitation goes once it is
    // older than its kind's lifetime; a kind the Market does not configure is left alone.
    const undispatchedCreatedBefore: Partial<Record<InvitationKind, Temporal.Instant>> = {};
    for (const kind of INVITATION_KINDS) {
      const minutes = this.deps.policy.invitationLifetimeMinutes(market, kind);
      if (minutes !== null) undispatchedCreatedBefore[kind] = now.subtract({ minutes });
    }
    const purgedInvitations = await unitOfWork.run(market, async () =>
      ok(
        await this.deps.invitations.purge(
          market,
          now,
          now.subtract({ hours: INVITATION_KEPT_AFTER_DECISION_HOURS }),
          undispatchedCreatedBefore,
        ),
      ),
    );

    return ok({
      sessions: purgedSessions.ok ? purgedSessions.value : 0,
      throttles: purgedThrottles.ok ? purgedThrottles.value : 0,
      signInRecords: purgedRecords,
      links: purgedLinks.ok ? purgedLinks.value : 0,
      challenges: purgedChallenges.ok ? purgedChallenges.value : 0,
      invitations: purgedInvitations.ok ? purgedInvitations.value : 0,
    });
  }
}
