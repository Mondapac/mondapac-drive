import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PLATFORM_ROLE_EDIT } from '../../contracts/permissions';
import {
  editCustomRole,
  type EditRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';

// Edit a custom platform role (identity design 5.3 `identity.platform-role.edit`, 5.4 R1 to R3,
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

/** Edits a custom platform role's name and keys; never a seeded role (R3, R10). */
export class EditPlatformRole extends UseCase<EditRoleInput, RoleWritten, RoleEditorFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.edit-platform-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_EDIT.key] },
  };

  readonly #logger = new Logger('EditPlatformRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RoleEditorDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: EditRoleInput,
  ): Promise<Result<RoleWritten, RoleEditorFailure>> {
    return editCustomRole(this.deps, EDITOR, this.#logger, context, input);
  }
}
