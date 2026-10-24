import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type {
  RoleAssignmentRepository,
  RoleRepository,
} from '../../application/ports/role.repository';
import {
  Role,
  RoleAssignment,
  type RoleEdit,
  type RoleKind,
  type RoleScope,
  type SeedUpgrade,
} from '../../domain/role';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

function marketOf(table: string, value: string): MarketId {
  const parsed = parseMarketId(value);
  if (!parsed.ok) throw new Error(`identity.${table}: a stored row is malformed`);
  return parsed.value;
}

const ROLE = {
  id: true,
  marketId: true,
  scope: true,
  kind: true,
  seedCode: true,
  seedVersion: true,
  name: true,
  version: true,
  createdAt: true,
} as const;

type RoleRow = {
  id: string;
  marketId: string;
  scope: string;
  kind: string;
  seedCode: string | null;
  seedVersion: number | null;
  name: string | null;
  version: number;
  createdAt: Date;
};

function restoreRole(row: RoleRow, permissionKeys: readonly string[]): Role {
  // The aggregate re-checks scope, kind, seed and keys (RoleInvariantError).
  return Role.restore({
    id: row.id as Id<'Role'>,
    marketId: marketOf('roles', row.marketId),
    scope: row.scope as RoleScope,
    kind: row.kind as RoleKind,
    seedCode: row.seedCode,
    seedVersion: row.seedVersion,
    name: row.name,
    permissionKeys,
    version: row.version,
    createdAt: toInstant(row.createdAt),
  });
}

/**
 * {@link RoleRepository} on `identity.roles` and `identity.role_permissions` (data design 3.9):
 * single-table statements with `marketId` at the top level of `where`, no join. A role's stored
 * keys are read with it, by `(market_id, role_id)`, the primary key's prefix.
 */
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSystemRole(market: MarketContext, scope: RoleScope): Promise<Role | null> {
    // One system role per scope and Market (`roles_market_id_scope_system_key`).
    const row = await this.prisma.tx(market).identityRole.findFirst({
      where: { marketId: market.marketId, scope, kind: 'system' },
      select: ROLE,
    });
    return this.withKeys(market, row);
  }

  async findById(market: MarketContext, id: Id<'Role'>): Promise<Role | null> {
    const row = await this.prisma.tx(market).identityRole.findFirst({
      where: { marketId: market.marketId, id },
      select: ROLE,
    });
    return this.withKeys(market, row);
  }

  async platformRoles(market: MarketContext): Promise<Role[]> {
    // `roles_market_id_scope_seed_code_key` serves the `(market_id, scope)` prefix.
    const rows = await this.prisma.tx(market).identityRole.findMany({
      where: { marketId: market.marketId, scope: 'platform' },
      select: ROLE,
      orderBy: { id: 'asc' },
    });
    return this.withKeysOf(market, rows);
  }

  async countCustom(market: MarketContext): Promise<number> {
    return this.prisma.tx(market).identityRole.count({
      where: { marketId: market.marketId, scope: 'platform', kind: 'custom' },
    });
  }

  async nameTaken(
    market: MarketContext,
    nameNormalized: string,
    exceptRoleId?: Id<'Role'>,
  ): Promise<boolean> {
    // The partial unique index `roles_market_id_name_platform_custom_key` serves this probe
    // and is the backstop.
    const row = await this.prisma.tx(market).identityRole.findFirst({
      where: {
        marketId: market.marketId,
        scope: 'platform',
        kind: 'custom',
        nameNormalized,
        ...(exceptRoleId === undefined ? {} : { id: { not: exceptRoleId } }),
      },
      select: { id: true },
    });
    return row !== null;
  }

  async addCustom(market: MarketContext, role: Role): Promise<void> {
    const state = role.state;
    if (state.kind !== 'custom' || state.name === null || state.name === undefined) {
      throw new Error('addCustom: only a custom role is added here');
    }
    await this.prisma.tx(market).identityRole.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        scope: state.scope,
        kind: state.kind,
        seedCode: null,
        seedVersion: null,
        name: state.name,
        nameNormalized: role.nameNormalized,
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    await this.addKeys(market, state.id, state.permissionKeys);
  }

  async saveCustom(market: MarketContext, edit: RoleEdit): Promise<void> {
    const { role } = edit;
    const state = role.state;
    const expected = role.persistedVersion;
    if (expected === null || state.name === null || state.name === undefined) {
      throw new Error('saveCustom: the role was never stored');
    }
    // The version guard first: a concurrent edit makes this one stale before it writes a key.
    const { count } = await this.prisma.tx(market).identityRole.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected, kind: 'custom' },
      data: { name: state.name, nameNormalized: role.nameNormalized, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('role', state.id);
    // Reconcile the key rows to the new set, so a stored key the registry dropped goes too.
    await this.prisma.tx(market).identityRolePermission.deleteMany({
      where: {
        marketId: market.marketId,
        roleId: state.id,
        permissionKey: { notIn: [...state.permissionKeys] },
      },
    });
    if (state.permissionKeys.length > 0) {
      await this.prisma.tx(market).identityRolePermission.createMany({
        data: state.permissionKeys.map((permissionKey) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          roleId: state.id,
          permissionKey,
        })),
        skipDuplicates: true,
      });
    }
  }

  async deleteCustom(market: MarketContext, role: Role): Promise<void> {
    const expected = role.persistedVersion;
    if (expected === null) throw new Error('deleteCustom: the role was never stored');
    // The key rows go with it (ON DELETE CASCADE); an assignment would refuse (RESTRICT).
    const { count } = await this.prisma.tx(market).identityRole.deleteMany({
      where: { marketId: market.marketId, id: role.state.id, version: expected, kind: 'custom' },
    });
    if (count !== 1) throw new StaleAggregateError('role', role.state.id);
  }

  async findBySeedCode(
    market: MarketContext,
    scope: RoleScope,
    seedCode: string,
  ): Promise<Role | null> {
    // `roles_market_id_scope_seed_code_key`.
    const row = await this.prisma.tx(market).identityRole.findFirst({
      where: { marketId: market.marketId, scope, seedCode },
      select: ROLE,
    });
    return this.withKeys(market, row);
  }

  async addSeeded(market: MarketContext, role: Role): Promise<boolean> {
    const state = role.state;
    if (state.kind === 'custom') throw new Error('addSeeded: a custom role is not seeded');
    // `INSERT … ON CONFLICT DO NOTHING`: a concurrent or repeated run converges on the seed
    // key or the one-system-role-per-scope key without aborting the unit (data design 8.3).
    const { count } = await this.prisma.tx(market).identityRole.createMany({
      data: [
        {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          scope: state.scope,
          kind: state.kind,
          seedCode: state.seedCode,
          seedVersion: state.seedVersion,
            version: state.version,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (count !== 1) return false;
    await this.addKeys(market, state.id, state.permissionKeys);
    return true;
  }

  async applySeed(market: MarketContext, upgrade: SeedUpgrade): Promise<void> {
    const { role, addedKeys, removedKeys } = upgrade;
    const state = role.state;
    const expected = role.persistedVersion;
    if (expected === null) throw new Error('applySeed: the role was never stored');
    // The version guard first: a concurrent run that upgraded the row meanwhile makes this one
    // stale before it writes a key row (data design 8.3).
    const { count } = await this.prisma.tx(market).identityRole.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: { seedVersion: state.seedVersion, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('role', state.id);
    await this.addKeys(market, state.id, addedKeys);
    if (removedKeys.length > 0) {
      await this.prisma.tx(market).identityRolePermission.deleteMany({
        where: {
          marketId: market.marketId,
          roleId: state.id,
          permissionKey: { in: [...removedKeys] },
        },
      });
    }
  }

  private async addKeys(
    market: MarketContext,
    roleId: Id<'Role'>,
    keys: readonly string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await this.prisma.tx(market).identityRolePermission.createMany({
      data: keys.map((permissionKey) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        roleId,
        permissionKey,
      })),
    });
  }

  /** The roles of these rows with their stored keys: one read on the primary key's prefix. */
  private async withKeysOf(market: MarketContext, rows: readonly RoleRow[]): Promise<Role[]> {
    if (rows.length === 0) return [];
    const keys = await this.prisma.tx(market).identityRolePermission.findMany({
      where: { marketId: market.marketId, roleId: { in: rows.map((row) => row.id) } },
      select: { roleId: true, permissionKey: true },
      orderBy: [{ roleId: 'asc' }, { permissionKey: 'asc' }],
    });
    const byRole = new Map<string, string[]>();
    for (const key of keys) {
      const list = byRole.get(key.roleId) ?? [];
      list.push(key.permissionKey);
      byRole.set(key.roleId, list);
    }
    return rows.map((row) => restoreRole(row, byRole.get(row.id) ?? []));
  }

  private async withKeys(market: MarketContext, row: RoleRow | null): Promise<Role | null> {
    if (row === null) return null;
    const keys = await this.prisma.tx(market).identityRolePermission.findMany({
      where: { marketId: market.marketId, roleId: row.id },
      select: { permissionKey: true },
      orderBy: { permissionKey: 'asc' },
    });
    return restoreRole(
      row,
      keys.map((k) => k.permissionKey),
    );
  }
}

/** {@link RoleAssignmentRepository} on `identity.role_assignments` (data design 3.9). */
export class PrismaRoleAssignmentRepository implements RoleAssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<RoleAssignment | null> {
    const row = await this.prisma.tx(market).identityRoleAssignment.findFirst({
      where: { marketId: market.marketId, accountId },
      select: {
        id: true,
        marketId: true,
        accountId: true,
        roleId: true,
        assignedByAccountId: true,
        assignedAt: true,
        version: true,
      },
    });
    if (row === null) return null;
    return RoleAssignment.restore({
      id: row.id as Id<'RoleAssignment'>,
      marketId: marketOf('role_assignments', row.marketId),
      accountId: row.accountId as Id<'Account'>,
      roleId: row.roleId as Id<'Role'>,
      assignedByAccountId: row.assignedByAccountId as Id<'Account'> | null,
      assignedAt: toInstant(row.assignedAt),
      version: row.version,
    });
  }

  async heldRoles(
    market: MarketContext,
    roleIds: readonly Id<'Role'>[],
  ): Promise<ReadonlySet<Id<'Role'>>> {
    if (roleIds.length === 0) return new Set();
    // `(market_id, role_id)`: the role foreign key's index; distinct roles that have a holder.
    const rows = await this.prisma.tx(market).identityRoleAssignment.findMany({
      where: { marketId: market.marketId, roleId: { in: [...roleIds] } },
      select: { roleId: true },
      distinct: ['roleId'],
    });
    return new Set(rows.map((row) => row.roleId as Id<'Role'>));
  }

  async hasActiveHolder(market: MarketContext, roleId: Id<'Role'>): Promise<boolean> {
    const row = await this.prisma.tx(market).identityRoleAssignment.findFirst({
      where: {
        marketId: market.marketId,
        roleId,
        account: { status: 'active', emailVerifiedAt: { not: null } },
      },
      select: { id: true },
    });
    return row !== null;
  }

  async activeHoldersOf(market: MarketContext, roleId: Id<'Role'>): Promise<Id<'Account'>[]> {
    // The same read as hasActiveHolder: `(market_id, role_id)`, then the account by its key
    // with the status and verification filter (data design 3.9).
    const rows = await this.prisma.tx(market).identityRoleAssignment.findMany({
      where: {
        marketId: market.marketId,
        roleId,
        account: { status: 'active', emailVerifiedAt: { not: null } },
      },
      select: { accountId: true },
    });
    return rows.map((row) => row.accountId as Id<'Account'>);
  }

  async save(market: MarketContext, assignment: RoleAssignment): Promise<void> {
    const state = assignment.state;
    const expected = assignment.persistedVersion;
    if (expected === null) throw new Error('save: the assignment was never stored; use add');
    if (state.version === expected) return;
    const { count } = await this.prisma.tx(market).identityRoleAssignment.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: {
        roleId: state.roleId,
        assignedByAccountId: state.assignedByAccountId,
        assignedAt: toDate(state.assignedAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('role-assignment', state.id);
  }

  async add(market: MarketContext, assignment: RoleAssignment): Promise<void> {
    const state = assignment.state;
    await this.prisma.tx(market).identityRoleAssignment.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: state.accountId,
        roleId: state.roleId,
        assignedByAccountId: state.assignedByAccountId,
        assignedAt: toDate(state.assignedAt),
        version: state.version,
      },
      select: { id: true },
    });
  }

  async remove(market: MarketContext, assignment: RoleAssignment): Promise<void> {
    const expected = assignment.persistedVersion;
    if (expected === null) throw new Error('remove: the assignment was never stored');
    const { count } = await this.prisma.tx(market).identityRoleAssignment.deleteMany({
      where: { marketId: market.marketId, id: assignment.state.id, version: expected },
    });
    if (count !== 1) throw new StaleAggregateError('role-assignment', assignment.state.id);
  }
}
