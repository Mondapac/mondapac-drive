import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  Population,
  Result,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { OneTimeLink } from '../../domain/one-time-link';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';

import { countMailAttempt } from '../sign-up/mail-attempt';
import type { FieldProblem } from '../field-problem';

export interface RequestPasswordResetInput {
  /** The population of the route (the admin panel's or the courier app's "Forgot password?"). */
  readonly population: 'admin' | 'courier';
  readonly email: string;
  /** The IPv4 address or the IPv6 /64 of the client (ADR-0037 resolver): the `mail.origin` key. */
  readonly origin: string;
}

/** The one answer for every address (AC 21; identity design 6.7, 8.6 row 1). */
export type RequestPasswordResetOutput = { readonly code: 'password-reset.accepted' };

export type RequestPasswordResetFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'access.unavailable' };

export interface RequestPasswordResetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * "Forgot password?" (identity design 3.7, 6.6 to 6.8; SEL-05, ACC-04, AC 13, AC 21; `ux.md` F3
 * steps 1 and 2, A5; slice 4). Rule `anonymous`. One answer, `password-reset.accepted`, whether
 * or not the address has an account of this population in this Market.
 *
 * The mail counters come first, in a short READ COMMITTED unit of their own, as at sign-up and
 * "send it again" (`countMailAttempt`): `mail.account` (the address) and `mail.origin` count every
 * request, and their verdict decides whether a mail may go (Mojtaba item 3). The sign-in counters
 * are not read: a reset stays available while sign-in is blocked (AC 13). Counters unreachable:
 * `access.unavailable`, for every address alike.
 *
 * Only then, and only for an active account whose email is verified (3.7: an unverified person
 * signs up again, 3.2), a second unit requests the account's `reset-password` link (a new row,
 * or the row requested again: the earlier token stops working) and records
 * `identity.one-time-link-requested.v1`; the mail handler mints the token and sends E8. An
 * unknown, unverified or disabled account gets nothing. Two requests that race on one link: the
 * loser changes nothing and answers the same.
 */
export class RequestPasswordReset extends UseCase<
  RequestPasswordResetInput,
  RequestPasswordResetOutput,
  RequestPasswordResetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.request-password-reset',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('RequestPasswordReset');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequestPasswordResetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequestPasswordResetInput,
  ): Promise<Result<RequestPasswordResetOutput, RequestPasswordResetFailure>> {
    const { market } = context;
    const { unitOfWork, accounts, links, outbox } = this.deps;
    const { population } = input;
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const accepted = ok({ code: 'password-reset.accepted' as const });

    const now = this.deps.clock.now();
    let allowed: boolean;
    try {
      allowed = await countMailAttempt(
        this.deps,
        context,
        population,
        email.value.normalized,
        input.origin,
        now,
      );
    } catch {
      // Fail closed (6.8): the counters could not be evaluated, so nothing is requested.
      this.log('identity.request-password-reset.unavailable', context, population);
      return err({ code: 'access.unavailable' });
    }
    if (!allowed) {
      this.log('identity.request-password-reset.mail-throttled', context, population);
      return accepted;
    }

    try {
      await unitOfWork.run(market, async () => {
        const account = await accounts.findByEmail(market, population, email.value.normalized);
        if (account === null || !account.isEmailVerified || account.state.status !== 'active') {
          return ok(undefined);
        }
        const found = await links.findFor(market, account.state.id, 'reset-password');
        let link: OneTimeLink;
        if (found === null) {
          link = OneTimeLink.request({
            id: this.deps.ids.next<'OneTimeLink'>(),
            marketId: market.marketId,
            accountId: account.state.id,
            purpose: 'reset-password',
            now,
            notify: true,
          });
          await links.add(market, link);
        } else {
          link = found;
          link.requestAgain(now, true);
          await links.save(market, link);
        }
        await outbox.append(context, link.pendingEvents);
        return ok(undefined);
      });
    } catch (error) {
      // A concurrent request renewed the same link first; it sends the mail (AC 21: same answer).
      if (!(error instanceof StaleAggregateError)) throw error;
    }
    return accepted;
  }

  /** The population and ids only: never the address (P 12.3). */
  private log(msg: string, context: CallContext, population: Population): void {
    this.#logger.log({
      msg,
      population,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
