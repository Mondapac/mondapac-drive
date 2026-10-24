import { ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { COURIER_ACCOUNT_VIEW } from '../../contracts/permissions';
import type { AccountRepository } from '../ports/account.repository';

export interface IsActiveCourierInput {
  readonly accountId: Id<'Account'>;
}

export type IsActiveCourierFailure = { readonly code: 'access.denied' };

export interface IsActiveCourierDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `isActiveCourier`: whether an account id names an active courier account of the context's
 * Market, for a dispatcher assigning a job (Hassan, WP2 review). Rule `permissions
 * [identity.courier-account.view]`, which the dispatcher and operator roles hold. Every miss
 * (unknown, another Market, another population, disabled) answers `false` alike.
 */
export class IsActiveCourier extends UseCase<
  IsActiveCourierInput,
  boolean,
  IsActiveCourierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.is-active-courier',
    rule: { kind: 'permissions', allOf: [COURIER_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IsActiveCourierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IsActiveCourierInput,
  ): Promise<Result<boolean, IsActiveCourierFailure>> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.accounts.findById(market, input.accountId)),
      { readOnly: true },
    );
    if (!read.ok) return ok(false);
    const account = read.value;
    return ok(
      account !== null &&
        account.state.population === 'courier' &&
        account.state.status === 'active',
    );
  }
}
