import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SessionRepository } from '../ports/session.repository';

export type SignOutOutput = { readonly code: 'signed-out' };
export type SignOutFailure = { readonly code: 'access.denied' };

export interface SignOutDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * Sign-out (identity design 3.5; brief s5): revokes the actor's own session, the one the request
 * was authenticated with, with the reason `sign-out`. Rule `own-resources`. A merchant's API key
 * is refused: only an operator revokes one. A session already revoked by a concurrent request
 * answers the same: the result is the same. The admin controller clears the cookie.
 */
export class SignOut extends UseCase<Record<string, never>, SignOutOutput, SignOutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-out',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignOutDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SignOutOutput, SignOutFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources.
    if (actor.kind !== 'authenticated' || actor.population === 'merchant') {
      return err({ code: 'access.denied' });
    }
    await this.deps.unitOfWork.run(market, async () => {
      await this.deps.sessions.revoke(
        market,
        actor.sessionId,
        actor.accountId,
        'sign-out',
        this.deps.clock.now(),
      );
      return ok(undefined);
    });
    return ok({ code: 'signed-out' });
  }
}
