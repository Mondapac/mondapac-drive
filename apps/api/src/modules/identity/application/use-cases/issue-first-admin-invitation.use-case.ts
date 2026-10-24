import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { InvitationIssuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../ports/invitation.repository';
import type { RoleRepository } from '../ports/role.repository';

export interface IssueFirstAdminInvitationInput {
  /** The first admin's address, typed by the operator. Personal data: never logged. */
  readonly email: string;
}

export interface IssueFirstAdminInvitationOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
  /** Whether a stale pending invitation for the same address was revoked first (item G). */
  readonly replaced: boolean;
}

export type IssueFirstAdminInvitationFailure =
  | { readonly code: 'validation.failed' }
  /** The Market already has an admin account (7.4). */
  | { readonly code: 'first-admin.exists' }
  /** The role seed has not run in this Market: the Platform Administrator role is missing. */
  | { readonly code: 'roles.not-seeded' }
  | { readonly code: 'invitation.already-pending' }
  /** The Market configures no admin invitation lifetime: nothing could be dispatched. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface IssueFirstAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly invitations: InvitationRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The operator's `first-admin` routine (identity design 7.4, 3.4; AC 22; HF5, HF15; slice 7b
 * items G and I). Rule `system`: the command runs it as the Market's `SYSTEM` actor after it has
 * written the operator's line to the external log (`platform-audit.md` 9.2, Hassan L6).
 *
 * Refused when the Market already has an admin account (`first-admin.exists`), or before the
 * role seed has stored the Platform Administrator role (`roles.not-seeded`). Otherwise an `admin`
 * invitation with that role and no inviter is issued for the address: there is never a default
 * password. Its acceptance is refused once the Market has an active Platform Administrator (HF5).
 *
 * Item G: a pending invitation for the same address that is past its expiry, or was never
 * dispatched and is older than the admin lifetime, is revoked and replaced in the same unit;
 * any other pending one answers `invitation.already-pending`. The unit records
 * `identity.invitation-issued.v1` (the mail handler mints the token and dispatches it, 6.6) and
 * writes `identity.invitation.issued` as `SYSTEM`; a replaced invitation records
 * `identity.invitation-revoked.v1` and `identity.invitation.revoked` as `SYSTEM` (slice 8b). The
 * address is never logged or audited.
 */
export class IssueFirstAdminInvitation extends UseCase<
  IssueFirstAdminInvitationInput,
  IssueFirstAdminInvitationOutput,
  IssueFirstAdminInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.issue-first-admin-invitation',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('IssueFirstAdminInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssueFirstAdminInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssueFirstAdminInvitationInput,
  ): Promise<Result<IssueFirstAdminInvitationOutput, IssueFirstAdminInvitationFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const email = parseEmailAddress(input.email);
    if (!email.ok) return err({ code: 'validation.failed' });
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'admin');
    if (lifetime === null) return err({ code: 'access.unavailable' });

    let result: Result<IssueFirstAdminInvitationOutput, IssueFirstAdminInvitationFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<IssueFirstAdminInvitationOutput, IssueFirstAdminInvitationFailure>
        > => {
          const now = this.deps.clock.now();
          if (await this.deps.accounts.existsInPopulation(market, 'admin')) {
            return err({ code: 'first-admin.exists' });
          }
          const role = await this.deps.roles.findSystemRole(market, 'platform');
          if (role === null) return err({ code: 'roles.not-seeded' });
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
            // Slice 8b: a revocation records `identity.invitation-revoked.v1` and, as every
            // revocation, its audit row, here as SYSTEM (Mohammad C3 on PR #187).
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
            invitedByAccountId: null,
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
      if (error instanceof InvitationAlreadyPendingError) {
        result = err({ code: 'invitation.already-pending' });
      } else {
        throw error;
      }
    }
    this.#logger.log({
      msg: 'identity.first-admin.invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? { invitationId: result.value.invitationId, replaced: result.value.replaced }
        : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
