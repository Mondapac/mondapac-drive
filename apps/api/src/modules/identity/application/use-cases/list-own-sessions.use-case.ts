import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { DeviceCode } from '../../domain/device';
import { sessionIsLive } from '../../domain/session';
import type { SessionRepository } from '../ports/session.repository';

/** One signed-in device of the holder. No session id, token or address leaves this use case. */
export interface OwnSessionView {
  /** The coarse device (`<browser>.<system>`); null for a session opened before it was kept. */
  readonly device: DeviceCode | null;
  /** ISO 8601 instants (UTC). */
  readonly signedInAt: string;
  readonly lastActiveAt: string;
  /** The session this request was made with. */
  readonly current: boolean;
}

export interface ListOwnSessionsOutput {
  /** The current session first, then the most recently used. */
  readonly items: readonly OwnSessionView[];
}

export type ListOwnSessionsFailure = { readonly code: 'access.denied' };

export interface ListOwnSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * The most sessions one list shows. A panel account has a handful; the rest of a larger set are
 * still ended by {@link SignOutOtherSessions}.
 */
export const OWN_SESSIONS_LIMIT = 50;

/**
 * The signed-in admin's or courier's own live sessions (profile package 4, active
 * sessions). Rule `own-resources`: the
 * sessions are the holder's own. The account is the actor's, so nobody lists another account's
 * sessions. A merchant's API key is refused (its keys are an operator's to list). One read-only unit; a session past its idle timeout
 * is left out by the same rule the Authenticator applies (`sessionIsLive`).
 */
export class ListOwnSessions extends UseCase<
  Record<string, never>,
  ListOwnSessionsOutput,
  ListOwnSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-own-sessions',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListOwnSessionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ListOwnSessionsOutput, ListOwnSessionsFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources.
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population === 'merchant') return err({ code: 'access.denied' });
    const now = this.deps.clock.now();
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.sessions.listUnrevokedOf(
            market,
            actor.accountId,
            now,
            OWN_SESSIONS_LIMIT,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const items = read.value
      .filter((session) => sessionIsLive(session, now))
      .map((session): OwnSessionView => ({
        device: session.device,
        signedInAt: session.createdAt.toString(),
        lastActiveAt: session.lastSeenAt.toString(),
        current: session.id === actor.sessionId,
      }));
    // Stable: the repository's order stays within each group.
    items.sort((a, b) => Number(b.current) - Number(a.current));
    return ok({ items });
  }
}
