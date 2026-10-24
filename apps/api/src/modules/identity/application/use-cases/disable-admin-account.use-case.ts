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
 * Disables another admin account (identity design 3.1 `active` → `disabled`; AC 11, AC 18, AC
 * 25, AC 33; slice 8b). Rule `permissions [identity.admin-account.disable]` (protected, R11).
 * Not oneself, never an admin who holds a key the actor lacks (R1), never the last Platform
 * Administrator who can sign in (R3, HF8): one serializable unit that also revokes every
 * session and voids every open challenge of the account (see `changeAccountStatus`).
 */
export class DisableAdminAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.disable-admin-account',
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
      to: 'disabled',
      ruleKey: ADMIN_ACCOUNT_DISABLE.key,
    });
  }
}
