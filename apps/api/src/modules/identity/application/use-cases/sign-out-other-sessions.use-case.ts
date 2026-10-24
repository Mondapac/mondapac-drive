import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { OtherSessionsSignedOutAudit } from '../../domain/audit';
import { sessionIsLive } from '../../domain/session';
import { reservationVerdict } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SessionRepository } from '../ports/session.repository';
import type { ThrottleRepository } from '../ports/throttle.repository';

export interface SignOutOtherSessionsOutput {
  readonly code: 'other-sessions-signed-out';
  /** How many sessions were ended; 0 when this was the only one. */
  readonly revokedSessions: number;
}

export type SignOutOtherSessionsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

export interface SignOutOtherSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly policy: IdentityMarketPolicy;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * "Sign out of all other devices" (profile package 4, active sessions): revokes every session of
 * the actor's own account except the one this request was made with, with the reason
 * `signed-out-elsewhere`. Rule `own-resources`: it only takes access away, so no code is asked for.
 * A merchant's API key is refused (its keys are an operator's to revoke).
 *
 * One read-write unit. It takes the account's credential lock first, as a password change does
 * (`revokeAllOf`), so a sign-in racing it is either committed and revoked here, or opens after
 * and is a new sign-in. The current session must still be live in the unit; revoked or expired meanwhile,
 * it answers `session.invalid` and nothing changes. Records
 * `identity.account.other-sessions-signed-out` (the kept session's id and the count) even when
 * nothing else was live, so the holder's action is on record.
 *
 * Hassan's two follow-ups (owner decision 2026-10-17):
 * - Rate limit: every call counts once on the account's `sign-out-others.account` counter (the
 *   Market's `signOutOthersThrottle`; AU 5 in 60 minutes) in the same unit. Above the limit it
 *   answers `request.throttled` with the wait, and the unit rolls back, so nothing changes.
 *   Without the Market's rule: `access.unavailable` (fail closed).
 * - Notice: when at least one session was ended, the account takes a version step that records
 *   `identity.account-other-sessions-signed-out.v1`, which mails the holder "your other devices
 *   were signed out" (`SendOtherSessionsSignedOutMail`), so a holder whose session was taken
 *   learns of it.
 */
export class SignOutOtherSessions extends UseCase<
  Record<string, never>,
  SignOutOtherSessionsOutput,
  SignOutOtherSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-out-other-sessions',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignOutOtherSessionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SignOutOtherSessionsOutput, SignOutOtherSessionsFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources.
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population === 'merchant') return err({ code: 'access.denied' });
    const population = actor.population;
    const rule = this.deps.policy.signOutOthersThrottle(market);
    if (rule === null) return err(UNAVAILABLE);
    const { accounts, sessions, throttles, keys, outbox, audit } = this.deps;
    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<SignOutOtherSessionsOutput, SignOutOtherSessionsFailure>> => {
          const now = this.deps.clock.now();
          if (!(await accounts.lockCredential(market, actor.accountId))) {
            return err({ code: 'session.invalid' });
          }
          const current = await sessions.findById(market, actor.sessionId);
          const account = await accounts.findById(market, actor.accountId);
          if (
            current === null ||
            account === null ||
            current.accountId !== actor.accountId ||
            !sessionIsLive(current, now)
          ) {
            return err({ code: 'session.invalid' });
          }
          const accountKey = keys.account(market, population, account.state.email.normalized);
          const [reservation] = await throttles.reserve(
            market,
            [{ kind: 'sign-out-others.account', keyHash: accountKey, accountKey, rule }],
            now,
          );
          const verdict = reservationVerdict([{ reservation: reservation!, rule }], now);
          if (!verdict.allowed) {
            return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
          }
          const revokedSessions = await sessions.revokeAllOf(
            market,
            actor.accountId,
            'signed-out-elsewhere',
            now,
            actor.sessionId,
          );
          if (revokedSessions > 0) {
            account.recordOtherSessionsSignedOut(now);
            await accounts.save(market, account);
            await outbox.append(context, account.pendingEvents);
          }
          await audit.record(
            context,
            OtherSessionsSignedOutAudit.entry(actor.accountId, {
              after: { keptSessionId: actor.sessionId, revokedSessions },
            }),
          );
          return ok({ code: 'other-sessions-signed-out', revokedSessions });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err(UNAVAILABLE);
      throw error;
    }
  }
}
