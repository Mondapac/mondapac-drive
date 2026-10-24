import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ADMIN_ACCOUNT_INVITE } from '../../contracts/permissions';
import { InvitationRevokedAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants } from '../roles/granting';

const RULE_KEYS = [ADMIN_ACCOUNT_INVITE.key];

export interface RevokeAdminInvitationInput {
  readonly invitationId: Id<'Invitation'>;
}

export interface RevokeAdminInvitationOutput {
  readonly code: 'invitation.revoked';
  readonly invitationId: Id<'Invitation'>;
}

export type RevokeAdminInvitationFailure =
  /** No admin invitation with this id in the Market: "not found". */
  | { readonly code: 'invitation.unknown' }
  /** Already accepted or revoked. */
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'access.denied' };

export interface RevokeAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly invitations: InvitationRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Revokes a pending admin invitation (identity design 3.4 `pending` → `revoked`; R12; slice 8b).
 * Rule `permissions [identity.admin-account.invite]` (protected). Any pending admin invitation of
 * the Market, expired ones and the operator's first-admin invitation included: revoking only
 * narrows access, so no `GrantPolicy` check is needed; the actor is re-checked in the unit
 * (still an active, verified admin holding the key; Mohammad C1 on PR #187). The address is cleared with the decision
 * (data design 4). `identity.invitation-revoked.v1` and `identity.invitation.revoked` as the
 * actor.
 */
export class RevokeAdminInvitation extends UseCase<
  RevokeAdminInvitationInput,
  RevokeAdminInvitationOutput,
  RevokeAdminInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.revoke-admin-invitation',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_INVITE.key] },
  };

  readonly #logger = new Logger('RevokeAdminInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RevokeAdminInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RevokeAdminInvitationInput,
  ): Promise<Result<RevokeAdminInvitationOutput, RevokeAdminInvitationFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<RevokeAdminInvitationOutput, RevokeAdminInvitationFailure>> => {
        // C1: the actor is still an active admin holding the rule's key, read in this unit.
        const self = { accountId: actor.accountId, population: 'admin' } as const;
        if ((await readActingGrants(this.deps, market, self, [], RULE_KEYS)) === null) {
          return err({ code: 'access.denied' });
        }
        const invitation = await this.deps.invitations.findById(market, input.invitationId);
        if (invitation === null || invitation.state.kind !== 'admin') {
          return err({ code: 'invitation.unknown' });
        }
        const roleId = invitation.state.roleId;
        if (!invitation.revoke(this.deps.clock.now()).ok) {
          return err({ code: 'invitation.rejected' });
        }
        await this.deps.invitations.save(market, invitation);
        await this.deps.outbox.append(context, invitation.pendingEvents);
        await this.deps.audit.record(
          context,
          InvitationRevokedAudit.entry(invitation.state.id, { after: { kind: 'admin', roleId } }),
        );
        return ok({ code: 'invitation.revoked', invitationId: invitation.state.id });
      },
    );
    this.#logger.log({
      msg: 'identity.revoke-admin-invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      invitationId: input.invitationId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
