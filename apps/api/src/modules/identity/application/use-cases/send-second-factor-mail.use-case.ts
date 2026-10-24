import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SecondFactorChange } from '../../domain/events';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';

/** One delivery of `identity.second-factor-changed.v1` (identity design 3.6, 8.2, 9). */
export interface SendSecondFactorMailInput {
  readonly delivery: EventDelivery;
  readonly accountId: Id;
  readonly change: SecondFactorChange;
  /** When it changed: the event's instant, written in the mail. */
  readonly occurredAt: Temporal.Instant;
}

export type SendSecondFactorMailOutput =
  | { readonly code: 'second-factor-mail.sent' }
  | {
      readonly code: 'second-factor-mail.skipped';
      readonly reason: 'account.gone' | 'change.silent';
    }
  | { readonly code: 'second-factor-mail.already-handled' };

export type SendSecondFactorMailFailure = { readonly code: 'access.denied' };

export interface SendSecondFactorMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The "your second factor changed" notice (identity design 3.6, 6.8, 9; slice 7b items C and E).
 * Rule `system`, from the subscription `identity.second-factor-mail` on
 * `identity.second-factor-changed.v1`. Mailed for `replaced` (a new device), `reset` (the
 * break-glass or a reset by an admin) and `locked` (HF2: too many wrong codes, the alert of 6.8);
 * `activated` and `recovery-codes-regenerated` happen in front of the holder and are skipped.
 *
 * As the password notice: to the account's own address whatever its state, not counted on the
 * mail counters, no button and no token; a read-only unit, the send outside any unit, then
 * `runOnce` marks the delivery (at least once). No log line holds the address or the body.
 */
export class SendSecondFactorMail extends UseCase<
  SendSecondFactorMailInput,
  SendSecondFactorMailOutput,
  SendSecondFactorMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-second-factor-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendSecondFactorMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendSecondFactorMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendSecondFactorMailInput,
  ): Promise<Result<SendSecondFactorMailOutput, SendSecondFactorMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;
    const change = input.change;
    // The changes the holder is mailed about (3.6: swap and reset; 6.8, HF2: the lock).
    const mailed = change === 'replaced' || change === 'reset' || change === 'locked';

    const loaded = mailed
      ? await unitOfWork.run(
          market,
          async () => ok(await accounts.findById(market, input.accountId as Id<'Account'>)),
          { readOnly: true },
        )
      : ok(null);
    if (!loaded.ok) throw new Error('send-second-factor-mail: the read unit failed');
    const account = loaded.value;

    if (account !== null && mailed) {
      const composed = this.deps.composer.compose(market, {
        template: 'second-factor-changed',
        population: account.state.population,
        change,
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
    if (!marked.ok) throw new Error('send-second-factor-mail: the inbox unit failed');
    const output: SendSecondFactorMailOutput = !marked.value.handled
      ? { code: 'second-factor-mail.already-handled' }
      : !mailed
        ? { code: 'second-factor-mail.skipped', reason: 'change.silent' }
        : account === null
          ? { code: 'second-factor-mail.skipped', reason: 'account.gone' }
          : { code: 'second-factor-mail.sent' };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(output.code === 'second-factor-mail.skipped' ? { reason: output.reason } : {}),
      change,
      accountId: input.accountId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
