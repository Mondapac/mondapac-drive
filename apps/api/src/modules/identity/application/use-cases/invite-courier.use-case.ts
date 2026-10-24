import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COURIER_ACCOUNT_INVITE } from '../../contracts/permissions';
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
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { reserveInvitationMail } from '../invitations/invitation-mail-budget';
import { readActingGrants, type ActingGrantDependencies } from '../roles/granting';
import type { FieldProblem } from '../field-problem';

const RULE_KEYS = [COURIER_ACCOUNT_INVITE.key];

export interface InviteCourierInput {
  /** The courier's address. Personal data: never logged or audited. */
  readonly email: string;
  /** The admin's client: the `mail.origin` key of the invitation mail (6.8). */
  readonly origin: string;
}

export interface InviteCourierOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
  /** Whether a stale pending invitation for the same address was revoked first (M7). */
  readonly replaced: boolean;
}

export type InviteCourierFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** The Market already has a courier account with this address. */
  | { readonly code: 'account.exists' }
  | { readonly code: 'invitation.already-pending' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** No courier invitation lifetime or no courier role in the Market. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface InviteCourierDependencies extends ActingGrantDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: Pick<RoleRepository, 'findSystemRole'>;
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
 * Invites a courier (Drive; the admin invitation of identity design 3.4 for the courier
 * population). Rule `permissions [identity.courier-account.invite]`: a dispatcher onboards
 * couriers. The role is always the courier system role of the Market, so there is no grant
 * check: a courier holds every courier key and nothing else.
 *
 * In one unit: the actor read again (C1); an address that already has a courier account is
 * `account.exists`; the mail counted on `mail.account` (courier population) and `mail.origin`
 * before the rows (6.8); one pending courier invitation per address, a stale one replaced and
 * audited as revoked (M7). Then the invitation without a token: its event's mail handler mints
 * the token and sends it (6.6). The address is never logged or audited.
 */
export class InviteCourier extends UseCase<
  InviteCourierInput,
  InviteCourierOutput,
  InviteCourierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.invite-courier',
    rule: { kind: 'permissions', allOf: [COURIER_ACCOUNT_INVITE.key] },
  };

  readonly #logger = new Logger('InviteCourier');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InviteCourierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: InviteCourierInput,
  ): Promise<Result<InviteCourierOutput, InviteCourierFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'courier');
    if (lifetime === null) return err({ code: 'access.unavailable' });
    const self = { accountId: actor.accountId, population: 'admin' as const };

    let result: Result<InviteCourierOutput, InviteCourierFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<InviteCourierOutput, InviteCourierFailure>> => {
          const now = this.deps.clock.now();
          if ((await readActingGrants(this.deps, market, self, [], RULE_KEYS)) === null) {
            return err({ code: 'access.denied' });
          }
          const role = await this.deps.roles.findSystemRole(market, 'courier');
          if (role === null) return err({ code: 'access.unavailable' });
          const existing = await this.deps.accounts.findByEmail(
            market,
            'courier',
            email.value.normalized,
          );
          if (existing !== null) return err({ code: 'account.exists' });
          const budget = await reserveInvitationMail(
            this.deps,
            market,
            'courier',
            email.value.normalized,
            input.origin,
            now,
          );
          if (!budget.allowed) {
            return err({ code: 'request.throttled', retryAfterSeconds: budget.retryAfterSeconds });
          }
          const pending = await this.deps.invitations.findPendingFor(
            market,
            'courier',
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
            kind: 'courier',
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
              after: { kind: 'courier', roleId: role.state.id },
            }),
          );
          return ok({ code: 'invitation.issued', invitationId: invitation.state.id, replaced });
        },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      result = err({ code: 'invitation.already-pending' });
    }
    this.#logger.log({
      msg: 'identity.invite-courier',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? { invitationId: result.value.invitationId, replaced: String(result.value.replaced) }
        : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
