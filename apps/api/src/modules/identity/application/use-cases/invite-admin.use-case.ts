import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { ADMIN_ACCOUNT_INVITE } from '../../contracts/permissions';
import { InvitationIssuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository } from '../ports/role.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { reserveInvitationMail } from '../invitations/invitation-mail-budget';
import {
  readActingGrants,
  roleGrantVerdict,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';
import type { FieldProblem } from '../field-problem';

const RULE_KEYS = [ADMIN_ACCOUNT_INVITE.key];

export interface InviteAdminInput {
  /** The invitee's address. Personal data: never logged or audited. */
  readonly email: string;
  readonly roleId: Id<'Role'>;
  /** The admin's client: the `mail.origin` key of the invitation mail (6.8). */
  readonly origin: string;
}

export interface InviteAdminOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
  /** Whether a stale pending invitation for the same address was revoked first (M7). */
  readonly replaced: boolean;
}

export type InviteAdminFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** No platform role with this id in the Market (also a seller's role): "not found". */
  | { readonly code: 'role.unknown' }
  | { readonly code: 'role.not-grantable' }
  /** The Market already has an admin account with this address (one per Market, ADR-0018). */
  | { readonly code: 'account.exists' }
  | { readonly code: 'invitation.already-pending' }
  /** `mail.account` of the invited address or `mail.origin` is used up (6.8). */
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The Market configures no admin invitation lifetime: nothing could be dispatched. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface InviteAdminDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly invitations: InvitationRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Invites an admin with a role (identity design 3.4 `(none)` → `pending`, 5.4 R1 and R11, 5.5;
 * AC 35, AC 37; R12; slice 8b). Rule `permissions [identity.admin-account.invite]` (protected).
 * The actor is the inviter: the invitation carries its account id, and the acceptance checks
 * again that it is still active and could still grant the role (Hassan 14.2).
 *
 * In one unit: the actor, still an active, verified admin holding the rule's key (Mohammad C1
 * on PR #187; else `access.denied`); the role, a platform role of the context Market (a seller's role is never in an
 * admin's reach, Hassan I-2: `role.unknown`); the actor's grant read in this unit and
 * `GrantPolicy.canGrant` (R1, R3, R11: `role.not-grantable`); an address that already has an
 * admin account in the Market is refused (`account.exists`), since acceptance could only fail;
 * one pending invitation per address in the platform scope (`invitation.already-pending`), a
 * stale one replaced (M7, item G) and audited as revoked. Before the invitation rows, the mail
 * is counted on `mail.account` of the address (admin population) and `mail.origin` of the client,
 * as the seller invitation does (6.8; Hassan, phase 2 follow-ups): used up is `request.throttled`
 * and nothing commits, so revoking and inviting again never mails past the re-send's counters.
 * Then the invitation, without a token:
 * `identity.invitation-issued.v1` (the mail handler mints the token and sends it, 6.6) and
 * `identity.invitation.issued` as the actor. The address is never logged or audited.
 *
 * Not serializable: it writes none of the tables HF8 counts; the acceptance, which does, is.
 */
export class InviteAdmin extends UseCase<InviteAdminInput, InviteAdminOutput, InviteAdminFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.invite-admin',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_INVITE.key] },
  };

  readonly #logger = new Logger('InviteAdmin');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InviteAdminDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: InviteAdminInput,
  ): Promise<Result<InviteAdminOutput, InviteAdminFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'admin');
    if (lifetime === null) return err({ code: 'access.unavailable' });
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin' };

    let result: Result<InviteAdminOutput, InviteAdminFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<InviteAdminOutput, InviteAdminFailure>> => {
          const now = this.deps.clock.now();
          // C1: the actor is still an active admin holding the rule's key, read in this unit.
          const reading = await readActingGrants(this.deps, market, self, [], RULE_KEYS);
          if (reading === null) return err({ code: 'access.denied' });
          const role = await this.deps.roles.findById(market, input.roleId);
          if (role === null || !roleIsInActorsReach(role, self)) {
            return err({ code: 'role.unknown' });
          }
          const granted = roleGrantVerdict(reading.actor, role, this.deps);
          if (!granted.ok) {
            this.log('identity.invite-admin.not-grantable', context, {
              reason: granted.error.reason,
            });
            return err({ code: 'role.not-grantable' });
          }
          const existing = await this.deps.accounts.findByEmail(
            market,
            'admin',
            email.value.normalized,
          );
          if (existing !== null) return err({ code: 'account.exists' });
          // Throttle rows first, then the invitation rows (data design 3.3), as InviteSeller.
          const budget = await reserveInvitationMail(
            this.deps,
            market,
            'admin',
            email.value.normalized,
            input.origin,
            now,
          );
          if (!budget.allowed) {
            return err({ code: 'request.throttled', retryAfterSeconds: budget.retryAfterSeconds });
          }
          const pending = await this.deps.invitations.findPendingFor(
            market,
            'admin',
            email.value.normalized,
          );
          let replaced = false;
          if (pending !== null) {
            if (!pending.replaceableAt(now, lifetime)) {
              return err({ code: 'invitation.already-pending' });
            }
            pending.revoke(now);
            await this.deps.invitations.save(market, pending);
            await this.deps.outbox.append(context, pending.pendingEvents);
            await this.deps.audit.record(
              context,
              InvitationRevokedAudit.entry(pending.state.id, {
                after: { kind: pending.state.kind, roleId: pending.state.roleId },
              }),
            );
            replaced = true;
          }
          const invitation = Invitation.issue({
            id: this.deps.ids.next<'Invitation'>(),
            marketId: market.marketId,
            kind: 'admin',
            email: email.value,
            roleId: role.state.id,
            invitedByAccountId: actor.accountId,
            now,
          });
          await this.deps.invitations.add(market, invitation);
          await this.deps.outbox.append(context, invitation.pendingEvents);
          await this.deps.audit.record(
            context,
            InvitationIssuedAudit.entry(invitation.state.id, {
              after: { kind: 'admin', roleId: role.state.id },
            }),
          );
          return ok({ code: 'invitation.issued', invitationId: invitation.state.id, replaced });
        },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      result = err({ code: 'invitation.already-pending' });
    }
    this.log('identity.invite-admin', context, {
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? { invitationId: result.value.invitationId, replaced: String(result.value.replaced) }
        : {}),
    });
    return result;
  }

  /** Ids and codes only: never the address (P 12.3; AC 12). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
