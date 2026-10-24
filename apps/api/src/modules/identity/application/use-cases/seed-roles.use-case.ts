import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { RoleSeeded, RoleSeedApplied } from '../../domain/audit';
import { Role } from '../../domain/role';
import type { RoleSeed, SeededRole } from '../ports/role-seed';
import type { RoleRepository } from '../ports/role.repository';
import { checkRoleSeedKeys, RoleSeedKeyError } from '../roles/role-seed-keys';

export interface SeedRolesOutput {
  /** Roles created by this run; 0 once the Market is seeded. */
  readonly created: number;
  /** Stored roles brought to a newer seed version by this run. */
  readonly upgraded: number;
}

export type SeedRolesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'seed.invalid' }
  /** One role or more failed (logged each); the other roles were seeded. */
  | { readonly code: 'seed.incomplete'; readonly failed: number };

export interface SeedRolesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly roles: RoleRepository;
  readonly seed: RoleSeed;
  /** The sealed permission registry: the seed's keys are checked against it on every run. */
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditWriter;
}

/** What one role's unit did. */
type Outcome =
  | { readonly kind: 'created'; readonly role: Role }
  | { readonly kind: 'upgraded'; readonly role: Role; readonly from: number }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stored-newer'; readonly stored: number }
  | { readonly kind: 'kind-mismatch' }
  | { readonly kind: 'failed'; readonly errorName: string };

/**
 * The seed routine of identity design 5.6 (slices 5 and 8a-1). Rule `system`, run per hosted
 * Market at worker start (`identity.seed-roles`, `runAtStart`) and then daily. Roles carry
 * `marketId` (R9), so rows cannot come from a migration (I9).
 *
 * The seed's keys are first checked against the sealed registry (unknown, wrong scope,
 * protected): a seed that disagrees is refused whole (`seed.invalid`), as it fails boot. Then,
 * for each role of the checked-in seed, one unit:
 *
 * - **missing**: creates it (a system role without keys, a default role with its keys) and
 *   writes `identity.role.seeded`; a concurrent run converges on the unique keys (data design
 *   8.3) and creates nothing;
 * - **stored at an older `seed_version`**: applies the newer version, an audited update and not
 *   `ON CONFLICT DO NOTHING` (Ali 2026-10-08; PA 14 condition 3): the version-guarded update of
 *   the role, its key rows added and removed key by key, and `identity.role.seed-applied` with
 *   the versions and the keys, in the same unit. This covers the system roles (no keys) and the
 *   default roles. A concurrent run that upgraded first makes this one stale: it is logged and
 *   the next run finds the role current;
 * - **stored at the same version**: nothing, and nothing is written;
 * - **stored at a newer version** (an older build running): never downgraded; a warning;
 * - **stored under the same code with another kind**: never changed; an error log.
 *
 * A refused audit row throws, so the role's change rolls back with it (PA W5). A role whose
 * unit fails for any reason but a concurrent run is logged as an error and skipped; the run goes
 * on with the other roles, so one bad role never keeps `seller-owner` from a new Market, and
 * ends as `seed.incomplete`, which the job reports as a failed run (Mohammad 3). Custom roles are
 * never touched (R10). No admin account is ever created here (slice 7). Logs carry ids and codes
 * only, never a role name.
 */
export class SeedRoles extends UseCase<Record<string, never>, SeedRolesOutput, SeedRolesFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.seed-roles',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedRoles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedRolesDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SeedRolesOutput, SeedRolesFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const seeded = this.deps.seed.roles();
    try {
      checkRoleSeedKeys(seeded, this.deps.permissions);
    } catch (error) {
      if (!(error instanceof RoleSeedKeyError)) throw error;
      this.#logger.error({
        msg: 'identity.seed-roles.invalid',
        problem: error.problem,
        seedCode: error.seedCode,
        key: error.key,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'seed.invalid' });
    }
    let created = 0;
    let upgraded = 0;
    let failed = 0;
    for (const role of seeded) {
      const outcome = await this.seedOne(context, role);
      const where = {
        scope: role.scope,
        seedCode: role.seedCode,
        marketId: market.marketId,
        correlationId: context.correlationId,
      };
      switch (outcome.kind) {
        case 'created':
          created += 1;
          this.#logger.log({
            msg: 'identity.seed-roles.created',
            roleId: outcome.role.state.id,
            kind: role.kind,
            seedVersion: role.seedVersion,
            ...where,
          });
          break;
        case 'upgraded':
          upgraded += 1;
          this.#logger.log({
            msg: 'identity.seed-roles.upgraded',
            roleId: outcome.role.state.id,
            fromSeedVersion: outcome.from,
            seedVersion: role.seedVersion,
            ...where,
          });
          break;
        case 'stored-newer':
          this.#logger.warn({
            msg: 'identity.seed-roles.stored-newer',
            storedSeedVersion: outcome.stored,
            seedVersion: role.seedVersion,
            ...where,
          });
          break;
        case 'kind-mismatch':
          this.#logger.error({
            msg: 'identity.seed-roles.kind-mismatch',
            kind: role.kind,
            ...where,
          });
          break;
        case 'failed':
          failed += 1;
          this.#logger.error({
            msg: 'identity.seed-roles.role-failed',
            errorName: outcome.errorName,
            ...where,
          });
          break;
        case 'unchanged':
          break;
      }
    }
    if (failed > 0) {
      this.#logger.error({
        msg: 'identity.seed-roles.incomplete',
        created,
        upgraded,
        failed,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'seed.incomplete', failed });
    }
    return ok({ created, upgraded });
  }

  private async seedOne(context: CallContext, seeded: SeededRole): Promise<Outcome> {
    const { market } = context;
    try {
      const done = await this.deps.unitOfWork.run(market, async () => {
        const stored = await this.deps.roles.findBySeedCode(market, seeded.scope, seeded.seedCode);
        if (stored === null) return ok(await this.create(context, seeded));
        const storedVersion = stored.state.seedVersion;
        if (stored.state.kind !== seeded.kind || storedVersion === null) {
          return ok<Outcome>({ kind: 'kind-mismatch' });
        }
        if (storedVersion > seeded.seedVersion) {
          return ok<Outcome>({ kind: 'stored-newer', stored: storedVersion });
        }
        if (storedVersion === seeded.seedVersion) return ok<Outcome>({ kind: 'unchanged' });
        const upgrade = stored.applySeed({
          seedVersion: seeded.seedVersion,
          permissionKeys: seeded.permissionKeys,
        });
        await this.deps.roles.applySeed(market, upgrade);
        // In the unit of the change; a refusal throws, so the upgrade rolls back with it.
        await this.deps.audit.record(
          context,
          RoleSeedApplied.entry(stored.state.id, {
            before: { seedVersion: upgrade.fromSeedVersion },
            after: {
              seedVersion: seeded.seedVersion,
              addedKeys: [...upgrade.addedKeys],
              removedKeys: [...upgrade.removedKeys],
            },
          }),
        );
        return ok<Outcome>({ kind: 'upgraded', role: upgrade.role, from: upgrade.fromSeedVersion });
      });
      return done.ok ? done.value : { kind: 'unchanged' };
    } catch (error) {
      // Any other failure: this role's unit rolled back; the run goes on with the next role.
      if (!(error instanceof StaleAggregateError)) {
        return { kind: 'failed', errorName: error instanceof Error ? error.name : 'unknown' };
      }
      // A concurrent run upgraded the role first: converge, the next run finds it current.
      this.#logger.log({
        msg: 'identity.seed-roles.concurrent',
        scope: seeded.scope,
        seedCode: seeded.seedCode,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { kind: 'unchanged' };
    }
  }

  private async create(context: CallContext, seeded: SeededRole): Promise<Outcome> {
    const { market } = context;
    const common = {
      id: this.deps.ids.next<'Role'>(),
      marketId: market.marketId,
      scope: seeded.scope,
      seedCode: seeded.seedCode,
      seedVersion: seeded.seedVersion,
      now: this.deps.clock.now(),
    };
    const role =
      seeded.kind === 'system'
        ? Role.seedSystem(common)
        : Role.seedDefault({ ...common, permissionKeys: seeded.permissionKeys });
    if (!(await this.deps.roles.addSeeded(market, role))) return { kind: 'unchanged' };
    // In the unit of the change; a refusal throws, so the role is not created either.
    await this.deps.audit.record(
      context,
      RoleSeeded.entry(role.state.id, {
        after: { scope: role.state.scope, kind: role.state.kind, seedVersion: seeded.seedVersion },
      }),
    );
    return { kind: 'created', role };
  }
}
