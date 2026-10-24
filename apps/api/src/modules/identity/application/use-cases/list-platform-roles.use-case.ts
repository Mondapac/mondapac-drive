import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  PLATFORM_ROLE_DELETE,
  PLATFORM_ROLE_EDIT,
  PLATFORM_ROLE_VIEW,
} from '../../contracts/permissions';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { buildRoleCatalogue, type RoleCatalogue, type RoleEntry } from '../roles/role-catalogue';

/** The read takes no parameter: no scope, no seller, no filter (Ali's 10a ruling). */
export type ListPlatformRolesInput = Readonly<Record<string, never>>;

/**
 * One platform role as the catalogue shows it (slice 10a, extended by slice 10): see
 * {@link RoleEntry}. A custom role has a `name`; a seeded role is labelled from `seedCode`.
 */
export type PlatformRoleEntry = RoleEntry;

/** The platform roles and the keys of the platform scope (slice 10). */
export type PlatformRoleCatalogue = RoleCatalogue;

export type ListPlatformRolesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListPlatformRolesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: Pick<RoleAssignmentRepository, 'heldRoles'>;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get' | 'list'>;
}

/**
 * The role catalogue read (identity design 5.3 `identity.platform-role.view`, 8.6 row 6; slice
 * 10a, Ali's ruling 2026-10-09): the platform roles of the context Market with, per role, whether
 * the actor may grant it. Rule `permissions [identity.platform-role.view]`, so a seller-side or
 * customer actor is refused by the gate. One read-only unit (ADR-0025: no transaction):
 *
 * 1. The actor first, as the commands read it (`readActingGrants` with the view key): an active,
 *    verified admin still holding the key, else `access.denied` before any role is read.
 * 2. Then the Market's platform roles (`RoleRepository.platformRoles`, which takes no scope:
 *    the seller scope is not reachable through this read). Each is also checked to be in the
 *    actor's reach, so a row that is not a platform role of this Market is never shown.
 * 3. Per role, `permissionCount` is the size of what it confers (`grantedRoleOf`, the one
 *    resolver) and `grantable` is `roleGrantVerdict`: the same function the assign, invite,
 *    re-send and acceptance checks call, never a second implementation.
 *
 * Slice 10 extends this read with the name, per-role key detail, per-key `grantable` and the
 * edit and delete hints (the seller scope has its own gate and rule in `ListSellerRoles`, over
 * the same builder: one read model, two rules because a rule names keys of one scope).
 */
export class ListPlatformRoles extends UseCase<
  ListPlatformRolesInput,
  PlatformRoleCatalogue,
  ListPlatformRolesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-platform-roles',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_VIEW.key] },
  };

  readonly #logger = new Logger('ListPlatformRoles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListPlatformRolesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListPlatformRolesInput,
  ): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> {
    const result = await this.list(context, input);
    // Codes and counts only: never a key, a role's name or anything personal.
    this.#logger.log({
      msg: 'identity.list-platform-roles',
      outcome: result.ok ? 'platform-roles.listed' : result.error.code,
      ...(result.ok
        ? {
            roles: result.value.items.length,
            grantable: result.value.items.filter((role) => role.grantable).length,
          }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ListPlatformRolesInput,
  ): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    // A closed input, also for a caller that is not the controller: no parameter selects a
    // scope, a seller or anything else.
    const unknown = Object.keys(input ?? {});
    if (unknown.length > 0) {
      return err({
        code: 'validation.failed',
        fields: unknown.sort().map((path) => ({ path, code: 'unknown' })),
      });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin' };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> => {
        // The actor first (Mohammad's 8c nit): refused before any role is read.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [PLATFORM_ROLE_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const roles = await this.deps.roles.platformRoles(market);
        // Only a custom role can be `role.in-use` (a seeded role is `role.read-only` first), so only
        // custom ids are asked: a shop's list never reads the assignments of the shared roles.
        const held = await this.deps.assignments.heldRoles(
          market,
          roles.filter((role) => role.state.kind === 'custom').map((role) => role.state.id),
        );
        const catalogue = buildRoleCatalogue({
          scope: 'platform',
          actor: acting.actor,
          subject: self,
          roles,
          held,
          editKey: PLATFORM_ROLE_EDIT.key,
          deleteKey: PLATFORM_ROLE_DELETE.key,
          deps: this.deps,
        });
        return ok(catalogue);
      },
      { readOnly: true },
    );
  }
}
