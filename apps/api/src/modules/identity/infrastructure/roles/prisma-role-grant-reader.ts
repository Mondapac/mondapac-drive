import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type { RoleGrant } from '../../application/access/effective-keys';
import type { RoleGrantReader } from '../../application/ports/role-grant-reader';

const SCOPES: ReadonlySet<string> = new Set(['platform', 'merchant', 'courier']);
const KINDS: ReadonlySet<string> = new Set(['system', 'default', 'custom']);

/**
 * {@link RoleGrantReader} on `identity.role_assignments`, `identity.roles` and
 * `identity.role_permissions` (data design 3.9; slice 8a-1). Three single-table reads, each with
 * `marketId` at the top level of `where`, no join: the assignments by `(market_id, account_id)`
 * (the unique key), the roles by `(market_id, id)`, and the stored keys of the roles that store
 * keys by `(market_id, role_id, …)`, the primary key's prefix. System roles store none (R3), so
 * their keys are never read. Runs in the caller's unit; no cache (R4).
 *
 * A row this code does not recognise (a scope or kind outside the CHECKs) grants nothing: the
 * account is left out, as one without an assignment, so a corrupt row can only narrow access.
 */
export class PrismaRoleGrantReader implements RoleGrantReader {
  constructor(private readonly prisma: PrismaService) {}

  async grantsOf(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, RoleGrant>> {
    const grants = new Map<Id<'Account'>, RoleGrant>();
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return grants;
    const tx = this.prisma.tx(market);
    const assignments = await tx.identityRoleAssignment.findMany({
      where: { marketId: market.marketId, accountId: { in: ids } },
      select: { accountId: true, roleId: true },
    });
    if (assignments.length === 0) return grants;
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const roles = await tx.identityRole.findMany({
      where: { marketId: market.marketId, id: { in: roleIds } },
      select: { id: true, scope: true, kind: true },
    });
    const storing = roles.filter((role) => role.kind !== 'system').map((role) => role.id);
    const keyRows =
      storing.length === 0
        ? []
        : await tx.identityRolePermission.findMany({
            where: { marketId: market.marketId, roleId: { in: storing } },
            select: { roleId: true, permissionKey: true },
          });
    const keysOf = new Map<string, string[]>();
    for (const row of keyRows) {
      const keys = keysOf.get(row.roleId) ?? [];
      keys.push(row.permissionKey);
      keysOf.set(row.roleId, keys);
    }
    const byId = new Map<string, RoleGrant>();
    for (const role of roles) {
      if (!SCOPES.has(role.scope) || !KINDS.has(role.kind)) continue;
      byId.set(
        role.id,
        Object.freeze({
          roleId: role.id as Id<'Role'>,
          kind: role.kind as RoleGrant['kind'],
          scope: role.scope as RoleGrant['scope'],
          storedKeys: Object.freeze(
            role.kind === 'system' ? [] : [...(keysOf.get(role.id) ?? [])].sort(),
          ),
        }),
      );
    }
    for (const assignment of assignments) {
      const grant = byId.get(assignment.roleId);
      if (grant !== undefined) grants.set(assignment.accountId as Id<'Account'>, grant);
    }
    return grants;
  }
}
