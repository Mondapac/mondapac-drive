import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import type { LinkPurpose, OneTimeLink } from '../../domain/one-time-link';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkPage, LinkTargets, LinkTokens } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';

/** One delivery of `identity.one-time-link-requested.v1` (identity design 3.7, 9). */
export interface SendLinkMailInput {
  readonly delivery: EventDelivery;
  readonly linkId: Id;
  readonly accountId: Id;
  readonly purpose: LinkPurpose;
  /** The link's version after the request the event announced (P 10). */
  readonly aggregateVersion: number;
}

/** Why no mail went: a code, for the log line. */
export type LinkMailSkipped =
  | 'link.gone'
  | 'link.superseded'
  | 'account.gone'
  | 'account.disabled'
  | 'account.unverified'
  | 'account.population';

export type SendLinkMailOutput =
  | { readonly code: 'link-mail.sent'; readonly issued: boolean }
  | { readonly code: 'link-mail.skipped'; readonly reason: LinkMailSkipped }
  | { readonly code: 'link-mail.already-handled' };

export type SendLinkMailFailure = { readonly code: 'access.denied' };

export interface SendLinkMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly linkTokens: LinkTokens;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * Each purpose's mail and page: the reset (E8), and the enrolment link of 3.6 (HF6; admins only,
 * the only population with a second factor).
 */
const MAIL_OF: Readonly<
  Record<LinkPurpose, { template: 'reset-password' | 'enrol-second-factor'; page: LinkPage }>
> = {
  'reset-password': { template: 'reset-password', page: 'reset-password' },
  'enrol-second-factor': { template: 'enrol-second-factor', page: 'enrol-second-factor' },
};

/**
 * Identity's own mail handler for a requested link (identity design 3.7, 6.6, 9; PN2; slice 3).
 * Rule `system`: it runs in the worker, as the Market's system actor, from the subscription
 * `identity.link-mail`. The order of 9:
 *
 * 1. A read-only unit loads the link and its account. Nothing is sent, and the delivery is only
 *    marked handled, when the link is gone, no longer the request the event announced (a newer
 *    request, an issue or a use since: its version differs), or the account is gone, disabled,
 *    for verification already verified, or for a reset (slice 4) not verified.
 * 2. Outside any unit: the token is minted, the mail rendered in the Market's locale and sent.
 *    A failed send throws; the delivery comes due again after its back-off (P 6.4).
 * 3. `runOnce`: the inbox row, then the hash is stored if the link is still the one announced
 *    (`issue` from `requested`), and the delivery is marked delivered, in one unit. If that unit
 *    fails after the send, the retry sends a new mail with a new token and the first link never
 *    works (6.6): mail is at least once.
 *
 * The raw token exists only in memory and in the mail. No log line holds it, the address or the
 * body (AC 12; P 12.3). A purpose without a mail, a lifetime or a page in this Market's
 * configuration throws: the delivery is retried and then dead-lettered with an alert, never
 * dropped silently.
 */
export class SendLinkMail extends UseCase<
  SendLinkMailInput,
  SendLinkMailOutput,
  SendLinkMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-link-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendLinkMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendLinkMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendLinkMailInput,
  ): Promise<Result<SendLinkMailOutput, SendLinkMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts, links, clock, policy } = this.deps;
    const linkId = input.linkId as Id<'OneTimeLink'>;

    // 1. Read what the mail needs (read-only unit, ADR-0025).
    const loaded = await unitOfWork.run(
      market,
      async () => {
        const link = await links.findById(market, linkId);
        const account =
          link === null ? null : await accounts.findById(market, link.state.accountId);
        return ok({ link, account });
      },
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-link-mail: the read unit failed');
    const { link, account } = loaded.value;
    const skipped = this.skipReason(link, account, input);
    if (skipped !== null) {
      const marked = await unitOfWork.runOnce(market, input.delivery, () =>
        Promise.resolve(ok(undefined)),
      );
      this.log(context, input, 'identity.link-mail.skipped', { reason: skipped });
      if (!marked.ok) throw new Error('send-link-mail: the inbox unit failed');
      return ok(
        marked.value.handled
          ? { code: 'link-mail.skipped', reason: skipped }
          : { code: 'link-mail.already-handled' },
      );
    }
    const population = account!.state.population;

    // 2. Mint, render and send, outside any unit (P 3.1 row 5; PN2).
    const mail = MAIL_OF[input.purpose];
    const lifetimeMinutes = policy.linkLifetimeMinutes(market, input.purpose);
    const target =
      mail === undefined ? null : this.deps.targets.target(market, population, mail.page);
    if (mail === undefined || lifetimeMinutes === null || target === null) {
      throw new Error(
        `send-link-mail: no mail, lifetime or page for ${input.purpose} (${population}) in ${market.marketId}`,
      );
    }
    const minted = this.deps.linkTokens.issue();
    const url = new URL(target);
    url.hash = minted.token;
    // The template/population pairs are checked at runtime by the composer (a missing key throws,
    // so the delivery is retried and dead-lettered); enrol-second-factor is only ever requested
    // for an admin, and `skipReason` skips it for any other population.
    const composed = this.deps.composer.compose(market, {
      template: mail.template,
      population,
      url: url.toString(),
      lifetimeMinutes,
    });
    const sender = policy.mailSender(market);
    await this.deps.transport.send({
      to: account!.state.email.typed,
      from: sender,
      subject: composed.subject,
      text: composed.text,
    });

    // 3. Store the hash with the inbox row and the delivery mark (runOnce).
    const stored = await unitOfWork.runOnce(market, input.delivery, async () => {
      const current = await links.findById(market, linkId);
      if (current === null || current.state.version !== input.aggregateVersion) return ok(false);
      const issued = current.issue(minted.tokenHash, clock.now(), lifetimeMinutes);
      if (!issued.ok) return ok(false);
      await links.save(market, current);
      return ok(true);
    });
    if (!stored.ok) throw new Error('send-link-mail: the issue unit failed');
    if (!stored.value.handled) {
      // Another attempt of this delivery handled it first; its mail holds the working link.
      this.log(context, input, 'identity.link-mail.already-handled', {});
      return ok({ code: 'link-mail.already-handled' });
    }
    this.log(context, input, 'identity.link-mail.sent', { issued: stored.value.value });
    return ok({ code: 'link-mail.sent', issued: stored.value.value });
  }

  private skipReason(
    link: OneTimeLink | null,
    account: Account | null,
    input: SendLinkMailInput,
  ): LinkMailSkipped | null {
    if (link === null) return 'link.gone';
    if (
      link.state.version !== input.aggregateVersion ||
      link.state.accountId !== input.accountId ||
      link.state.purpose !== input.purpose ||
      link.statusAt(this.deps.clock.now()) !== 'requested'
    ) {
      return 'link.superseded';
    }
    if (account === null) return 'account.gone';
    if (account.state.status !== 'active') return 'account.disabled';
    // A merchant's integration account is never mailed; a factor is an admin's only.
    if (account.state.population === 'merchant') return 'account.population';
    if (input.purpose === 'enrol-second-factor' && account.state.population !== 'admin') {
      return 'account.population';
    }
    // 3.7: no reset link for an unverified account (it signs up again, 3.2).
    if (input.purpose === 'reset-password' && !account.isEmailVerified) {
      return 'account.unverified';
    }
    return null;
  }

  /** Ids and codes only: never the address, the token or the body (P 12.3; AC 12). */
  private log(
    context: CallContext,
    input: SendLinkMailInput,
    msg: string,
    fields: Record<string, string | boolean>,
  ): void {
    this.#logger.log({
      msg,
      linkId: input.linkId,
      purpose: input.purpose,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      ...fields,
    });
  }
}
