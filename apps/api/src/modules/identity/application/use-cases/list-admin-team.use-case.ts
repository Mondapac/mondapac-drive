import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  ADMIN_ACCOUNT_DISABLE,
  ADMIN_ACCOUNT_INVITE,
  ADMIN_ACCOUNT_RESET_SECOND_FACTOR,
  ADMIN_ACCOUNT_VIEW,
  PLATFORM_ROLE_ASSIGN,
} from '../../contracts/permissions';
import type { ActedOnAccount, GrantingActor } from '../../domain/grant-policy';
import { invitationStatusAt } from '../../domain/invitation';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import type { Role, RoleKind } from '../../domain/role';
import {
  adminInvitationResendVerdict,
  isSystemRole,
  mayActOnAdmin,
  secondFactorResetVerdict,
  statusChangeVerdict,
} from '../accounts/admin-verdicts';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { AdminAccountReader, AdminAccountSummary } from '../ports/admin-account-reader';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository, PendingInvitation } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import {
  readActingGrants,
  readGrants,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';

/** The largest page of the admin team list; the default page of the route is smaller. */
export const MAX_ADMIN_TEAM_PAGE = 100;

export interface ListAdminTeamInput {
  /** The last id of the previous page; absent or null for the first page. */
  readonly after?: string | null;
  readonly limit: number;
}

/**
 * Whether the actor may take an action on a row now, and if not, the code the command would
 * answer (identity design 8.6 row 6). A hint only: every command checks again in its own unit.
 */
export type ActionHint =
  | { readonly allowed: true; readonly code: null }
  | { readonly allowed: false; readonly code: string };

/**
 * A role as a row shows it: its id, its kind (a system role gets a lock), its seed code and, for a
 * custom role, its name (slice 10: personal free text, shown to a holder of
 * `identity.admin-account.view`; never logged).
 */
export interface AdminTeamRole {
  readonly roleId: Id<'Role'>;
  readonly kind: RoleKind;
  /** The seed code of a system or default role (its label is a translation key); else null. */
  readonly seedCode: string | null;
  /** The name of a custom role; null for a seeded role (labelled from `seedCode`). */
  readonly name: string | null;
}

export interface AdminTeamAccountRow {
  readonly type: 'account';
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  /** The actor's own row ("You"). */
  readonly self: boolean;
  /** Null only for an account without an assignment (a corrupt store). */
  readonly role: AdminTeamRole | null;
  readonly actions: {
    readonly changeRole: ActionHint;
    readonly disable: ActionHint;
    readonly enable: ActionHint;
    readonly resetSecondFactor: ActionHint;
  };
}

export interface AdminTeamInvitationRow {
  readonly type: 'invitation';
  readonly invitationId: Id<'Invitation'>;
  readonly email: string;
  /** Null when the role no longer exists (R12): the invitation cannot be accepted. */
  readonly role: AdminTeamRole | null;
  /** Null for the first-admin invitation. */
  readonly invitedByAccountId: Id<'Account'> | null;
  /** `expired`: past the expiry of its last mail; it can be re-sent within its lifetime. */
  readonly status: 'pending' | 'expired';
  readonly createdAt: Temporal.Instant;
  /** Null until its mail is sent (and right after a re-send). */
  readonly expiresAt: Temporal.Instant | null;
  readonly actions: { readonly resend: ActionHint; readonly revoke: ActionHint };
}

export type AdminTeamRow = AdminTeamAccountRow | AdminTeamInvitationRow;

export interface AdminTeamPage {
  /** Admin accounts and pending admin invitations, merged by id (UUID v7: creation order). */
  readonly items: readonly AdminTeamRow[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

export type ListAdminTeamFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListAdminTeamDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly adminAccounts: AdminAccountReader;
  readonly invitations: InvitationRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const ALLOWED: ActionHint = Object.freeze({ allowed: true, code: null });
const denied = (code: string): ActionHint => Object.freeze({ allowed: false, code });
const hintOf = (result: Result<unknown, { readonly code: string }>): ActionHint =>
  result.ok ? ALLOWED : denied(result.error.code);

/**
 * The admin team list (identity design 5.3 `identity.admin-account.view`, 8.6 rows 2 and 6;
 * slice 8c; Ali's ruling 2026-10-08): the admin accounts of the context Market with their roles,
 * and its pending admin invitations, each row with an `allowed` flag and a denial code per
 * action. Rule `permissions [identity.admin-account.view]`. One read-only unit (ADR-0025: no
 * transaction), so the rows and their hints are not one snapshot; they are hints only.
 *
 * **Hints (no second implementation).** Each hint runs, after the action's own key, the same
 * function its command runs after its gate (`application/accounts/admin-verdicts.ts`):
 * change role `mayActOnAdmin` then `LastHolderPolicy` on the Platform Administrator role (which
 * role is grantable is the role catalogue's `grantable`, slice 10a); disable and enable
 * `statusChangeVerdict`; reset `secondFactorResetVerdict`; re-send
 * `adminInvitationResendVerdict`; revoke needs only its key (the list holds pending invitations
 * only). An action whose key the actor lacks is `access.denied` and nothing else is evaluated or
 * read for it, so no hint tells more than the command would answer the same actor.
 *
 * Never in an answer: a token or its hash, a credential, a factor's secret or recovery codes.
 */
export class ListAdminTeam extends UseCase<
  ListAdminTeamInput,
  AdminTeamPage,
  ListAdminTeamFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-admin-team',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_VIEW.key] },
  };

  readonly #logger = new Logger('ListAdminTeam');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListAdminTeamDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListAdminTeamInput,
  ): Promise<Result<AdminTeamPage, ListAdminTeamFailure>> {
    const { market, actor } = context;
    const result = await this.list(context, input);
    this.#logger.log({
      msg: 'identity.list-admin-team',
      outcome: result.ok ? 'admin-team.listed' : result.error.code,
      ...(result.ok ? { rows: result.value.items.length, more: result.value.next !== null } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ListAdminTeamInput,
  ): Promise<Result<AdminTeamPage, ListAdminTeamFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_TEAM_PAGE) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    let after: string | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = parseId(input.after);
      if (!parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] });
      }
      after = parsed.value;
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin' };
    // Read before the unit, as the re-send command does: null answers `access.unavailable`.
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'admin');
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<AdminTeamPage, ListAdminTeamFailure>> => {
        const now = this.deps.clock.now();
        // The actor first, read in this unit as the commands read it (C1): an active, verified
        // admin holding the view key, else the whole list is refused before any row, and so any
        // personal data, is read (Mohammad on PR #196). Its keys decide every hint.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [ADMIN_ACCOUNT_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        // One row more of each than the page tells whether another page exists.
        const accounts = await this.deps.adminAccounts.adminAccounts(
          market,
          after as Id<'Account'> | null,
          limit + 1,
        );
        const invitations = await this.deps.invitations.pendingInvitations(
          market,
          'admin',
          after as Id<'Invitation'> | null,
          limit + 1,
        );
        const merged: PageEntry[] = [
          ...accounts.map((row) => ({ id: row.accountId, account: row })),
          ...invitations.map((row) => ({ id: row.id, invitation: row })),
        ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const page = merged.slice(0, limit);
        const pageAccounts = page.flatMap((row) => ('account' in row ? [row.account] : []));
        const subjects: GrantSubject[] = pageAccounts.map((row) => ({
          accountId: row.accountId,
          population: 'admin',
        }));
        // The effective keys of the page's accounts, by the one resolver (`canActOn` reads them).
        const targets =
          (await readGrants(this.deps.grants, this.deps.effectiveKeys, market, self, subjects))
            ?.targets ?? new Map<Id<'Account'>, ActedOnAccount>();
        const reading = { actor: acting.actor, targets };
        const rows = await new RowBuilder(
          this.deps,
          context,
          reading.actor,
          self,
          now,
          lifetime,
          reading.targets,
        ).build(page, pageAccounts);
        const more = merged.length > limit;
        return ok({ items: rows, next: more ? page[page.length - 1]!.id : null });
      },
      { readOnly: true },
    );
  }
}

type PageEntry =
  | { readonly id: string; readonly account: AdminAccountSummary }
  | { readonly id: string; readonly invitation: PendingInvitation };

/** Builds the rows of one page and their hints, reading what a hint needs once per page. */
class RowBuilder {
  readonly #roles = new Map<string, Promise<Role | null>>();
  #holders: Promise<readonly Id<'Account'>[]> | null = null;

  constructor(
    private readonly deps: ListAdminTeamDependencies,
    private readonly context: CallContext,
    private readonly actor: GrantingActor,
    private readonly self: GrantSubject,
    private readonly now: Temporal.Instant,
    private readonly lifetime: number | null,
    private readonly targets: ReadonlyMap<Id<'Account'>, ActedOnAccount>,
  ) {}

  private holds(key: string): boolean {
    return this.actor.effectiveKeys.has(key);
  }

  private role(roleId: Id<'Role'>): Promise<Role | null> {
    let found = this.#roles.get(roleId);
    if (found === undefined) {
      found = this.deps.roles.findById(this.context.market, roleId);
      this.#roles.set(roleId, found);
    }
    return found;
  }

  /** The active, verified holders of the system role: read once, and only when a hint asks. */
  private holders(systemRoleId: Id<'Role'>): Promise<readonly Id<'Account'>[]> {
    this.#holders ??= this.deps.assignments.activeHoldersOf(this.context.market, systemRoleId);
    return this.#holders;
  }

  private shown(role: Role | null): AdminTeamRole | null {
    // A role out of an admin's reach is never one of an admin's (R2, R9); shown as none.
    if (role === null || !roleIsInActorsReach(role, this.self)) return null;
    return {
      roleId: role.state.id,
      kind: role.state.kind,
      seedCode: role.state.seedCode,
      name: role.state.kind === 'custom' ? (role.state.name ?? null) : null,
    };
  }

  async build(
    page: readonly PageEntry[],
    pageAccounts: readonly AdminAccountSummary[],
  ): Promise<AdminTeamRow[]> {
    const { market } = this.context;
    const ids = pageAccounts.map((row) => row.accountId);
    const grants = await this.deps.grants.grantsOf(market, ids);
    const systemRoleId =
      (await this.deps.roles.findSystemRole(market, 'platform'))?.state.id ?? null;
    // Read only for an actor who may reset; ids only.
    const withFactor =
      ids.length > 0 && this.holds(ADMIN_ACCOUNT_RESET_SECOND_FACTOR.key)
        ? await this.deps.factors.presentAmong(market, ids)
        : new Set<Id<'Account'>>();
    const rows: AdminTeamRow[] = [];
    for (const entry of page) {
      if ('account' in entry) {
        const roleId = grants.get(entry.account.accountId)?.roleId ?? null;
        rows.push(await this.accountRow(entry.account, roleId, systemRoleId, withFactor));
      } else {
        rows.push(await this.invitationRow(entry.invitation));
      }
    }
    return rows;
  }

  private async accountRow(
    account: AdminAccountSummary,
    roleId: Id<'Role'> | null,
    systemRoleId: Id<'Role'> | null,
    withFactor: ReadonlySet<Id<'Account'>>,
  ): Promise<AdminTeamAccountRow> {
    const target = this.targets.get(account.accountId)!;
    const holders = () => this.holders(systemRoleId!);
    const status = (to: 'active' | 'disabled') =>
      statusChangeVerdict({
        actor: this.actor,
        target,
        population: 'admin',
        status: account.status,
        to,
        targetRoleId: roleId,
        systemRoleId,
        holders,
      }).then(hintOf);
    return {
      type: 'account',
      accountId: account.accountId,
      email: account.email,
      displayName: account.displayName,
      status: account.status,
      self: account.accountId === this.actor.accountId,
      role: roleId === null ? null : this.shown(await this.role(roleId)),
      actions: {
        changeRole: this.holds(PLATFORM_ROLE_ASSIGN.key)
          ? await this.changeRoleHint(target, roleId, systemRoleId, holders)
          : denied('access.denied'),
        disable: this.holds(ADMIN_ACCOUNT_DISABLE.key)
          ? await status('disabled')
          : denied('access.denied'),
        enable: this.holds(ADMIN_ACCOUNT_DISABLE.key)
          ? await status('active')
          : denied('access.denied'),
        resetSecondFactor: this.holds(ADMIN_ACCOUNT_RESET_SECOND_FACTOR.key)
          ? hintOf(
              await secondFactorResetVerdict({
                actor: this.actor,
                target,
                targetRoleId: roleId,
                systemRoleId,
                factorExists: () => Promise.resolve(withFactor.has(account.accountId)),
              }),
            )
          : denied('access.denied'),
      },
    };
  }

  /**
   * The row part of `AssignAdminRole`: `mayActOnAdmin`, an assignment must exist, and a holder
   * of the Platform Administrator role who is its last holder loses it with any other role
   * (`LastHolderPolicy`). Whether a given role is grantable is not a row hint (`role.unknown`,
   * `canGrant` for the chosen role: the slice 10a role read's `grantable`; Hassan L2). Mirror of
   * `AssignAdminRole`'s target steps; change both together.
   */
  private async changeRoleHint(
    target: ActedOnAccount,
    roleId: Id<'Role'> | null,
    systemRoleId: Id<'Role'> | null,
    holders: () => Promise<readonly Id<'Account'>[]>,
  ): Promise<ActionHint> {
    const acted = mayActOnAdmin(this.actor, target, roleId, systemRoleId);
    if (!acted.ok) return hintOf(acted);
    if (roleId === null) return denied('account.unknown');
    if (!isSystemRole(roleId, systemRoleId)) return ALLOWED;
    return hintOf(LastHolderPolicy.allowsLosing(await holders(), target.accountId));
  }

  private async invitationRow(invitation: PendingInvitation): Promise<AdminTeamInvitationRow> {
    const role = await this.role(invitation.roleId);
    return {
      type: 'invitation',
      invitationId: invitation.id,
      email: invitation.email,
      role: this.shown(role),
      invitedByAccountId: invitation.invitedByAccountId,
      status: invitationStatusAt(invitation, this.now) === 'expired' ? 'expired' : 'pending',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      actions: {
        resend: await this.resendHint(invitation),
        revoke: this.holds(ADMIN_ACCOUNT_INVITE.key) ? ALLOWED : denied('access.denied'),
      },
    };
  }

  private async resendHint(invitation: PendingInvitation): Promise<ActionHint> {
    if (!this.holds(ADMIN_ACCOUNT_INVITE.key)) return denied('access.denied');
    if (this.lifetime === null) return denied('access.unavailable');
    const verdict = await adminInvitationResendVerdict(
      this.deps,
      this.context.market,
      { self: this.self, view: this.actor },
      invitation,
      this.now,
      this.lifetime,
    );
    return verdict.ok ? ALLOWED : denied(verdict.error.code);
  }
}
