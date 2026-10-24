import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';

/** One delivery of `identity.account-other-sessions-signed-out.v1` (profile package 4). */
export interface SendOtherSessionsSignedOutMailInput {
  readonly delivery: EventDelivery;
  readonly accountId: Id;
  /** When the other sessions were signed out: the event's instant, written in the mail. */
  readonly occurredAt: Temporal.Instant;
}

export type SendOtherSessionsSignedOutMailOutput =
  | { readonly code: 'other-sessions-signed-out-mail.sent' }
  | {
      readonly code: 'other-sessions-signed-out-mail.skipped';
      readonly reason: 'account.gone' | 'population.none';
    }
  | { readonly code: 'other-sessions-signed-out-mail.already-handled' };

export type SendOtherSessionsSignedOutMailFailure = { readonly code: 'access.denied' };

export interface SendOtherSessionsSignedOutMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The "your other devices were signed out" notice (profile package 4; Hassan's follow-up). Rule
 * `system`, from the subscription `identity.other-sessions-signed-out-mail`. As the "password
 * changed" notice (E13): to the account's own address whatever its state, not counted on the mail
 * counters (the action itself is throttled), no button and no token: when, and "if this wasn't
 * you". A holder whose session was taken learns that someone signed the other devices out.
 *
 * A read-only unit loads the account, the mail is sent outside any unit, and `runOnce` marks the
 * delivery (at least once). An account that is gone is skipped, and so is a customer account,
 * which never records the event. No log line holds the address or the body.
 */
export class SendOtherSessionsSignedOutMail extends UseCase<
  SendOtherSessionsSignedOutMailInput,
  SendOtherSessionsSignedOutMailOutput,
  SendOtherSessionsSignedOutMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-other-sessions-signed-out-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendOtherSessionsSignedOutMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendOtherSessionsSignedOutMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendOtherSessionsSignedOutMailInput,
  ): Promise<Result<SendOtherSessionsSignedOutMailOutput, SendOtherSessionsSignedOutMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;

    const loaded = await unitOfWork.run(
      market,
      async () => ok(await accounts.findById(market, input.accountId as Id<'Account'>)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-other-sessions-signed-out-mail: the read unit failed');
    const account = loaded.value;
    const population = account?.state.population;

    if (account !== null && population !== undefined && population !== 'merchant') {
      const composed = this.deps.composer.compose(market, {
        template: 'other-sessions-signed-out',
        population,
        changedAt: input.occurredAt,
      });
      await this.deps.transport.send({
        to: account.state.email.typed,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
    }

    const marked = await unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('send-other-sessions-signed-out-mail: the inbox unit failed');
    const output: SendOtherSessionsSignedOutMailOutput = !marked.value.handled
      ? { code: 'other-sessions-signed-out-mail.already-handled' }
      : account === null
        ? { code: 'other-sessions-signed-out-mail.skipped', reason: 'account.gone' }
        : population === 'merchant'
          ? { code: 'other-sessions-signed-out-mail.skipped', reason: 'population.none' }
          : { code: 'other-sessions-signed-out-mail.sent' };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(output.code === 'other-sessions-signed-out-mail.skipped'
        ? { reason: output.reason }
        : {}),
      accountId: input.accountId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
