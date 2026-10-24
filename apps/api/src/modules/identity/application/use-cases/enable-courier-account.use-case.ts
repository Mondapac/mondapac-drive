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
 * Enables a disabled courier account again (identity design 3.1 `disabled` → `active`, decided
 * by Ali 14.1-8; slice 8b). Rule `permissions [identity.courier-account.disable]`. Serializable
 * (HF8).
 */
export class EnableCourierAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.enable-courier-account',
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
      to: 'active',
    });
  }
}
