import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Invitation } from '../../domain/invitation';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { LinkTargets } from '../ports/link-secrets';
import type { OpaqueTokens } from '../ports/second-factor-tokens';

/** One delivery of `identity.invitation-issued.v1` (identity design 3.4, 6.6, 9). */
export interface SendInvitationMailInput {
  readonly delivery: EventDelivery;
  readonly invitationId: Id;
  /** The invitation's version after the issue the event announced (P 10). */
  readonly aggregateVersion: number;
}

export type InvitationMailSkipped = 'invitation.gone' | 'invitation.superseded';

export type SendInvitationMailOutput =
  | { readonly code: 'invitation-mail.sent'; readonly dispatched: boolean }
  | { readonly code: 'invitation-mail.skipped'; readonly reason: InvitationMailSkipped }
  | { readonly code: 'invitation-mail.already-handled' };

export type SendInvitationMailFailure = { readonly code: 'access.denied' };

export interface SendInvitationMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly invitations: InvitationRepository;
  readonly invitationTokens: OpaqueTokens;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * Identity's mail handler for an issued invitation (identity design 3.4, 6.6, 9; PN2; slice 7b).
 * Rule `system`, from the subscription `identity.invitation-mail`. The order of 9, as the link
 * mail:
 *
 * 1. A read-only unit loads the invitation. Nothing is sent, and the delivery is only marked,
 *    when it is gone or no longer the issue the event announced (another version, or decided).
 * 2. Outside any unit: the token is minted (`mi1_`), the mail rendered in the Market's locale with
 *    the token in the fragment of the acceptance page, and sent.
 * 3. `runOnce`: the inbox row, then the token's hash and the expiry (`dispatch`, the kind's
 *    lifetime) stored if the invitation is still the one announced. A retry after a failed unit
 *    sends a new mail and the first token never works (6.6).
 *
 * Slice 7b sends the `admin` kind (the first-admin routine), slice 9 the `seller-owner` kind (E9,
 * to the seller panel's acceptance page), slice 11 the `staff` kind (E10, to the same page). A
 * missing lifetime or page throws, so a delivery is dead-lettered with an alert, never dropped.
 * The token, the address and the body are never logged.
 */
export class SendInvitationMail extends UseCase<
  SendInvitationMailInput,
  SendInvitationMailOutput,
  SendInvitationMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-invitation-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendInvitationMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendInvitationMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendInvitationMailInput,
  ): Promise<Result<SendInvitationMailOutput, SendInvitationMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, invitations, policy } = this.deps;
    const invitationId = input.invitationId as Id<'Invitation'>;

    const loaded = await unitOfWork.run(
      market,
      async () => ok(await invitations.findById(market, invitationId)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-invitation-mail: the read unit failed');
    const invitation = loaded.value;
    const skipped = this.skipReason(invitation, input);
    if (skipped !== null) {
      const marked = await unitOfWork.runOnce(market, input.delivery, () =>
        Promise.resolve(ok(undefined)),
      );
      this.log(context, input, 'identity.invitation-mail.skipped', { reason: skipped });
      if (!marked.ok) throw new Error('send-invitation-mail: the inbox unit failed');
      return ok(
        marked.value.handled
          ? { code: 'invitation-mail.skipped', reason: skipped }
          : { code: 'invitation-mail.already-handled' },
      );
    }
    const { kind, email } = invitation!.state;
    // The population the invitee joins: the admin panel's (E11) or the courier app's.
    const population = kind;
    const lifetimeMinutes = policy.invitationLifetimeMinutes(market, kind);
    const target = this.deps.targets.target(market, population, 'accept-invitation');
    if (lifetimeMinutes === null || target === null || email === null) {
      throw new Error(
        `send-invitation-mail: no lifetime or page for ${kind} in ${market.marketId}`,
      );
    }
    const minted = this.deps.invitationTokens.issue();
    const url = new URL(target);
    url.hash = minted.token;
    const composed = this.deps.composer.compose(market, {
      template: 'invitation',
      population,
      url: url.toString(),
      lifetimeMinutes,
    });
    await this.deps.transport.send({
      to: email.typed,
      from: policy.mailSender(market),
      subject: composed.subject,
      text: composed.text,
    });

    const stored = await unitOfWork.runOnce(market, input.delivery, async () => {
      const current = await invitations.findById(market, invitationId);
      if (current === null || current.state.version !== input.aggregateVersion) return ok(false);
      const dispatched = current.dispatch(minted.tokenHash, this.deps.clock.now(), lifetimeMinutes);
      if (!dispatched.ok) return ok(false);
      await invitations.save(market, current);
      return ok(true);
    });
    if (!stored.ok) throw new Error('send-invitation-mail: the dispatch unit failed');
    if (!stored.value.handled) {
      this.log(context, input, 'identity.invitation-mail.already-handled', {});
      return ok({ code: 'invitation-mail.already-handled' });
    }
    this.log(context, input, 'identity.invitation-mail.sent', { dispatched: stored.value.value });
    return ok({ code: 'invitation-mail.sent', dispatched: stored.value.value });
  }

  private skipReason(
    invitation: Invitation | null,
    input: SendInvitationMailInput,
  ): InvitationMailSkipped | null {
    if (invitation === null) return 'invitation.gone';
    if (
      invitation.state.version !== input.aggregateVersion ||
      invitation.state.state !== 'pending'
    ) {
      return 'invitation.superseded';
    }
    return null;
  }

  /** Ids and codes only: never the address, the token or the body (P 12.3; AC 12). */
  private log(
    context: CallContext,
    input: SendInvitationMailInput,
    msg: string,
    fields: Record<string, string | boolean>,
  ): void {
    this.#logger.log({
      msg,
      invitationId: input.invitationId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      ...fields,
    });
  }
}
