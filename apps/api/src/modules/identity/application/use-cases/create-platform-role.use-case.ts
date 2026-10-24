import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PLATFORM_ROLE_CREATE } from '../../contracts/permissions';
import {
  createCustomRole,
  type CreateRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';

// Create a custom platform role (identity design 5.3 `identity.platform-role.create`, 5.4 R1 to R3,
// R5, R7, R9 to R11; slice 10): a thin use case over the shared core in `roles/role-editor.ts`,
// with its own protected key as the rule. The keys are protected (R11), so in Phase 2 only a holder of the Platform
// Administrator role, or of a custom role it created with them, can run it.

const EDITOR: RoleEditorScope = {
  scope: 'platform',
  population: 'admin',
  createKey: 'identity.platform-role.create',
  editKey: 'identity.platform-role.edit',
  deleteKey: 'identity.platform-role.delete',
};

/** Creates a custom platform role: a name and a key set the actor may grant (R1, R11). */
export class CreatePlatformRole extends UseCase<CreateRoleInput, RoleWritten, RoleEditorFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.create-platform-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_CREATE.key] },
  };

  readonly #logger = new Logger('CreatePlatformRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RoleEditorDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CreateRoleInput,
  ): Promise<Result<RoleWritten, RoleEditorFailure>> {
    return createCustomRole(this.deps, EDITOR, this.#logger, context, input);
  }
}
