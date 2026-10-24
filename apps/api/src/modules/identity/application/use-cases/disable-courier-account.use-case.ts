import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COURIER_ACCOUNT_DISABLE } from '../../contracts/permissions';
import {
  changeAccountStatus,
  type AccountStatusDependencies,
  type AccountStatusFailure,
  type AccountStatusInput,
  type AccountStatusOutput,
} from '../accounts/account-status';

/**
 * Disables a courier account (identity design 3.1 `active` → `disabled`; AC 11, AC 18; slice
 * 8b). Rule `permissions [identity.courier-account.disable]`. A dispatcher onboards and
 * offboards couriers, so the key is not protected. One serializable unit that also revokes every session
 * of the account (see `changeAccountStatus`).
 */
export class DisableCourierAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.disable-courier-account',
    rule: { kind: 'permissions', allOf: [COURIER_ACCOUNT_DISABLE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountStatusDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AccountStatusInput,
  ): Promise<Result<AccountStatusOutput, AccountStatusFailure>> {
    return changeAccountStatus(this.deps, context, input, {
      population: 'courier',
      ruleKey: COURIER_ACCOUNT_DISABLE.key,
      to: 'disabled',
    });
  }
}
