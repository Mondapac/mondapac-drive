import type { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { RoleCreatedAudit, RoleDeletedAudit, RoleUpdatedAudit } from '../../domain/audit';
import { parseRoleName, Role, normalizeRoleName } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import { readActingGrants, roleIsInActorsReach, type GrantSubject } from './granting';
import {
  customRoleGrantVerdict,
  parseRoleKeys,
  roleDeleteVerdict,
  roleEditVerdict,
} from './role-editing';

// The three commands of the role editor (identity design 5.3, 5.4 R1 to R3, R5, R7, R10, R11,
// 2.3). Custom roles exist in platform scope only in Drive; the use case supplies its keys and
// every rule is here, in the application layer,
// and the verdicts it calls are those of `role-editing.ts`, which the catalogue's hints call too.
// Each command runs in **one serializable unit** (HF8: the limit, the name's uniqueness and
// "nobody holds it" are all counted reads) and re-reads the actor in that unit (Mohammad C1).

/** The editor's scope and the keys of its three commands. */
export interface RoleEditorScope {
  readonly scope: 'platform';
  readonly population: 'admin';
  readonly createKey: string;
  readonly editKey: string;
  readonly deleteKey: string;
}

export interface RoleEditorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: Pick<RoleAssignmentRepository, 'heldRoles'>;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get' | 'list'>;
  readonly policy: Pick<IdentityMarketPolicy, 'customRoleLimit'>;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly permissionKeys: readonly string[];
}

export interface EditRoleInput extends CreateRoleInput {
  readonly roleId: Id<'Role'>;
}

export interface DeleteRoleInput {
  readonly roleId: Id<'Role'>;
}

export type RoleEditorFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** A role of another scope or of another Market: "not found" (5.2). */
  | { readonly code: 'role.unknown' }
  | { readonly code: 'role.read-only' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'role.in-use' }
  | { readonly code: 'role.name-taken' }
  | { readonly code: 'role.limit' };

export interface RoleWritten {
  readonly code: 'role.created' | 'role.updated' | 'role.unchanged' | 'role.deleted';
  readonly roleId: Id<'Role'>;
}

type Outcome = Result<RoleWritten, RoleEditorFailure>;

/** The actor as a grant subject, or null: only the scope's population. */
function subjectOf(context: CallContext, editor: RoleEditorScope): GrantSubject | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== editor.population) return null;
  return { accountId: actor.accountId, population: editor.population };
}

const invalidName = (rule: string): Outcome =>
  err({ code: 'validation.failed', fields: [{ path: 'name', code: rule }] });

function log(
  logger: Logger,
  msg: string,
  context: CallContext,
  fields: Record<string, string>,
): void {
  // Ids and codes only: never the role's name or a key list (R5).
  logger.log({
    msg,
    ...fields,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/** Create a custom role (`.role.create`). */
export async function createCustomRole(
  deps: RoleEditorDependencies,
  editor: RoleEditorScope,
  logger: Logger,
  context: CallContext,
  input: CreateRoleInput,
): Promise<Outcome> {
  const { market } = context;
  const self = subjectOf(context, editor);
  const finish = (result: Outcome): Outcome => {
    log(logger, `identity.create-${editor.scope}-role`, context, {
      outcome: result.ok ? result.value.code : result.error.code,
    });
    return result;
  };
  if (self === null) return finish(err({ code: 'access.denied' }));
  const name = parseRoleName(input?.name);
  if (!name.ok) return finish(invalidName(name.error.rule));
  const keys = parseRoleKeys(input.permissionKeys, editor.scope, deps.permissions);
  if (!keys.ok) return finish(err(keys.error));
  // Fail closed while the Market configures no limit (identity design 2.3).
  const limit = deps.policy.customRoleLimit(market, editor.scope);
  if (limit === null) return finish(err({ code: 'access.unavailable' }));
  return finish(
    await deps.unitOfWork.run(
      market,
      async (): Promise<Outcome> => {
        const acting = await readActingGrants(deps, market, self, [], [editor.createKey]);
        if (acting === null) return err({ code: 'access.denied' });
        const id = deps.ids.next<'Role'>();
        const granted = customRoleGrantVerdict(acting.actor, editor.scope, keys.value, deps, id);
        if (!granted.ok) {
          log(logger, `identity.create-${editor.scope}-role.not-grantable`, context, {
            reason: granted.error.reason,
          });
          return err({ code: 'role.not-grantable' });
        }
        if (await deps.roles.nameTaken(market, normalizeRoleName(name.value))) {
          return err({ code: 'role.name-taken' });
        }
        if ((await deps.roles.countCustom(market)) >= limit) {
          return err({ code: 'role.limit' });
        }
        const role = Role.createCustom({
          id,
          marketId: market.marketId,
          scope: editor.scope,
          name: name.value,
          permissionKeys: keys.value,
          now: deps.clock.now(),
        });
        await deps.roles.addCustom(market, role);
        await deps.outbox.append(context, role.pendingEvents);
        await deps.audit.record(
          context,
          RoleCreatedAudit.entry(id, {
            after: { scope: editor.scope, addedKeys: [...keys.value] },
          }),
        );
        return ok({ code: 'role.created', roleId: id });
      },
      { isolation: 'serializable' },
    ),
  );
}

/** Edit a custom role (`.role.edit`): its name and its whole key set. */
export async function editCustomRole(
  deps: RoleEditorDependencies,
  editor: RoleEditorScope,
  logger: Logger,
  context: CallContext,
  input: EditRoleInput,
): Promise<Outcome> {
  const { market } = context;
  const self = subjectOf(context, editor);
  const finish = (result: Outcome): Outcome => {
    log(logger, `identity.edit-${editor.scope}-role`, context, {
      outcome: result.ok ? result.value.code : result.error.code,
    });
    return result;
  };
  if (self === null) return finish(err({ code: 'access.denied' }));
  const name = parseRoleName(input?.name);
  if (!name.ok) return finish(invalidName(name.error.rule));
  const keys = parseRoleKeys(input.permissionKeys, editor.scope, deps.permissions);
  if (!keys.ok) return finish(err(keys.error));
  const isDeclared = (key: string): boolean => deps.permissions.get(key) !== undefined;
  return finish(
    await deps.unitOfWork.run(
      market,
      async (): Promise<Outcome> => {
        const acting = await readActingGrants(deps, market, self, [], [editor.editKey]);
        if (acting === null) return err({ code: 'access.denied' });
        const role = await deps.roles.findById(market, input.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) return err({ code: 'role.unknown' });
        // The actor must dominate the role as it stands (R1, R11), then as it will be.
        const editable = roleEditVerdict(acting.actor, role, deps);
        if (!editable.ok) {
          if (editable.error.code === 'role.not-grantable') {
            log(logger, `identity.edit-${editor.scope}-role.not-grantable`, context, {
              reason: editable.error.reason,
            });
          }
          return err({ code: editable.error.code as 'role.read-only' | 'role.not-grantable' });
        }
        const granted = customRoleGrantVerdict(
          acting.actor,
          editor.scope,
          keys.value,
          deps,
          role.state.id,
        );
        if (!granted.ok) {
          log(logger, `identity.edit-${editor.scope}-role.not-grantable`, context, {
            reason: granted.error.reason,
          });
          return err({ code: 'role.not-grantable' });
        }
        const sameKeys =
          role.state.permissionKeys.length === keys.value.length &&
          role.state.permissionKeys.every((key, index) => key === keys.value[index]);
        if (sameKeys && role.state.name === name.value) {
          return ok({ code: 'role.unchanged', roleId: role.state.id });
        }
        if (
          role.nameNormalized !== normalizeRoleName(name.value) &&
          (await deps.roles.nameTaken(market, normalizeRoleName(name.value), role.state.id))
        ) {
          return err({ code: 'role.name-taken' });
        }
        const edit = role.edit({
          name: name.value,
          permissionKeys: keys.value,
          isDeclared,
          now: deps.clock.now(),
        });
        await deps.roles.saveCustom(market, edit);
        await deps.outbox.append(context, edit.role.pendingEvents);
        await deps.audit.record(
          context,
          RoleUpdatedAudit.entry(role.state.id, {
            after: {
              scope: editor.scope,
              addedKeys: [...edit.addedKeys],
              removedKeys: [...edit.removedKeys],
              renamed: edit.renamed,
            },
          }),
        );
        return ok({ code: 'role.updated', roleId: role.state.id });
      },
      { isolation: 'serializable' },
    ),
  );
}

/** Delete a custom role nobody holds (`.role.delete`). */
export async function deleteCustomRole(
  deps: RoleEditorDependencies,
  editor: RoleEditorScope,
  logger: Logger,
  context: CallContext,
  input: DeleteRoleInput,
): Promise<Outcome> {
  const { market } = context;
  const self = subjectOf(context, editor);
  const finish = (result: Outcome): Outcome => {
    log(logger, `identity.delete-${editor.scope}-role`, context, {
      outcome: result.ok ? result.value.code : result.error.code,
    });
    return result;
  };
  if (self === null) return finish(err({ code: 'access.denied' }));
  const isDeclared = (key: string): boolean => deps.permissions.get(key) !== undefined;
  return finish(
    await deps.unitOfWork.run(
      market,
      async (): Promise<Outcome> => {
        const acting = await readActingGrants(deps, market, self, [], [editor.deleteKey]);
        if (acting === null) return err({ code: 'access.denied' });
        const role = await deps.roles.findById(market, input.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) return err({ code: 'role.unknown' });
        const held = (await deps.assignments.heldRoles(market, [role.state.id])).has(role.state.id);
        const deletable = roleDeleteVerdict(acting.actor, role, held, deps);
        if (!deletable.ok) {
          if (deletable.error.code === 'role.not-grantable') {
            log(logger, `identity.delete-${editor.scope}-role.not-grantable`, context, {
              reason: deletable.error.reason,
            });
          }
          return err({ code: deletable.error.code });
        }
        const removed = role.remove({ isDeclared, now: deps.clock.now() });
        await deps.roles.deleteCustom(market, removed);
        await deps.outbox.append(context, removed.pendingEvents);
        await deps.audit.record(
          context,
          RoleDeletedAudit.entry(role.state.id, {
            before: {
              scope: editor.scope,
              removedKeys: role.state.permissionKeys.filter(isDeclared),
            },
          }),
        );
        return ok({ code: 'role.deleted', roleId: role.state.id });
      },
      { isolation: 'serializable' },
    ),
  );
}
