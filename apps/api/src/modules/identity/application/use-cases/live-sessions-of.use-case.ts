import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sessionIsLive } from '../../domain/session';
import type { SessionRepository } from '../ports/session.repository';

/** The most sessions one check answers; a courier has few. */
export const MAX_LIVE_SESSION_CHECK = 50;

export interface LiveSessionsOfInput {
  readonly accountId: Id<'Account'>;
  readonly sessionIds: readonly string[];
}

export type LiveSessionsOfFailure =
  { readonly code: 'access.denied' } | { readonly code: 'identity.unavailable' };

export interface LiveSessionsOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * `liveSessionsOf`: which of the given session ids of an account are live at this moment (not
 * revoked, not past their absolute expiry, not idle-timed-out), for notifications to push only
 * to the device of a session that still lives (Hassan M1 on handoff 33). Rule `system`: no
 * route reaches it. Ids only; an unknown id, another account's or another Market's answers as
 * not live.
 */
export class LiveSessionsOf extends UseCase<
  LiveSessionsOfInput,
  ReadonlySet<string>,
  LiveSessionsOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.live-sessions-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LiveSessionsOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: LiveSessionsOfInput,
  ): Promise<Result<ReadonlySet<string>, LiveSessionsOfFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const wanted = new Set(input.sessionIds);
    if (wanted.size === 0) return ok(new Set());
    const { market } = context;
    const now = this.deps.clock.now();
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.sessions.listUnrevokedOf(
            market,
            input.accountId,
            now,
            MAX_LIVE_SESSION_CHECK,
          ),
        ),
      { readOnly: true },
    );
    // Never "no session lives" for a read that failed: the caller would drop live devices.
    if (!read.ok) return err({ code: 'identity.unavailable' });
    return ok(
      new Set(
        read.value
          .filter((session) => wanted.has(session.id) && sessionIsLive(session, now))
          .map((session) => session.id as string),
      ),
    );
  }
}
