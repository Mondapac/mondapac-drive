import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ADMIN_ACCOUNT_DISABLE } from '../../contracts/permissions';
import {
  changeAccountStatus,
  type AccountStatusDependencies,
  type AccountStatusFailure,
  type AccountStatusInput,
  type AccountStatusOutput,
} from '../accounts/account-status';

/**
 * Enables a disabled admin account again (identity design 3.1 `disabled` → `active`, decided by
 * Ali 14.1-8; slice 8b). Rule `permissions [identity.admin-account.disable]`, with the guards of
 * a disable except the last holder: not oneself, R1, R3. Serializable (HF8). The account signs
 * in again; nothing it lost at the disable comes back.
 */
export class EnableAdminAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.enable-admin-account',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_DISABLE.key] },
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
      population: 'admin',
      to: 'active',
      ruleKey: ADMIN_ACCOUNT_DISABLE.key,
    });
  }
}
