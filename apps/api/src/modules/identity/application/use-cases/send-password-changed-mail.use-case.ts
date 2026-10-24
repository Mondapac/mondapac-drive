import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PasswordChangeCause } from '../../domain/account';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';

/** One delivery of `identity.account-password-changed.v1` (identity design 3.7, 8.2, 9). */
export interface SendPasswordChangedMailInput {
  readonly delivery: EventDelivery;
  readonly accountId: Id;
  readonly cause: PasswordChangeCause;
  /** When the password was changed: the event's instant, written in the mail. */
  readonly occurredAt: Temporal.Instant;
}

export type SendPasswordChangedMailOutput =
  | { readonly code: 'password-changed-mail.sent' }
  | { readonly code: 'password-changed-mail.skipped'; readonly reason: 'account.gone' }
  | { readonly code: 'password-changed-mail.already-handled' };

export type SendPasswordChangedMailFailure = { readonly code: 'access.denied' };

export interface SendPasswordChangedMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The "your password was changed" notice (identity design 3.7, 9; `ux.md` E13, 3.4; AC 8, AC 32;
 * slice 4). Rule `system`, from the subscription `identity.password-changed-mail` on
 * `identity.account-password-changed.v1`, for a reset and for a change alike. It goes to the
 * account's own address whatever the account's state now: it is a security notice, and only the
 * holder of that mailbox reads it. It is not counted on the mail counters: the change itself
 * was throttled. A notice without a button: what changed, when (the event's instant, in the
 * Market's zone), and "if this wasn't you, reset your password". No token.
 *
 * As the other handlers (PN2): a read-only unit loads the account, the mail is sent outside any
 * unit, and `runOnce` marks the delivery; a crash in between sends it again (at least once). An
 * account that is gone (the unverified purge cannot reach a verified account, so only erasure)
 * is skipped. No log line holds the address or the body.
 */
export class SendPasswordChangedMail extends UseCase<
  SendPasswordChangedMailInput,
  SendPasswordChangedMailOutput,
  SendPasswordChangedMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-password-changed-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendPasswordChangedMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendPasswordChangedMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendPasswordChangedMailInput,
  ): Promise<Result<SendPasswordChangedMailOutput, SendPasswordChangedMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;

    const loaded = await unitOfWork.run(
      market,
      async () => ok(await accounts.findById(market, input.accountId as Id<'Account'>)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-password-changed-mail: the read unit failed');
    const account = loaded.value;

    if (account !== null) {
      const composed = this.deps.composer.compose(market, {
        template: 'password-changed',
        population: account.state.population,
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
    if (!marked.ok) throw new Error('send-password-changed-mail: the inbox unit failed');
    const output: SendPasswordChangedMailOutput = !marked.value.handled
      ? { code: 'password-changed-mail.already-handled' }
      : account === null
        ? { code: 'password-changed-mail.skipped', reason: 'account.gone' }
        : { code: 'password-changed-mail.sent' };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(output.code === 'password-changed-mail.skipped' ? { reason: output.reason } : {}),
      cause: input.cause,
      accountId: input.accountId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
