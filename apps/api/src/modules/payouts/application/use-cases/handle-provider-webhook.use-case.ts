import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  money,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { reversalOf } from '../../domain/ledger';
import { lineReversed } from '../../domain/payout-run';
import { refusingBrokenRules, type PayoutsFailure } from '../failure';
import {
  LEDGER_REPOSITORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYOUT_RUN_REPOSITORY,
  PROVIDER_WEBHOOK_VERIFIER,
  type LedgerRepository,
  type PayoutAccountRepository,
  type PayoutRunRepository,
  type ProviderEvent,
  type ProviderWebhookVerifier,
} from '../ports';

/** What a webhook did: acted, found nothing of this Market to act on, or saw the event before. */
export type WebhookOutcome = 'applied' | 'ignored' | 'duplicate';

/**
 * Handles one payment-provider webhook for a Market: verifies its signature over the raw body,
 * records the event id once (a redelivery does nothing), and applies what payouts acts on. An
 * account update sets whether the courier's account can be paid out; a transfer reversal marks
 * its line and credits the reversed portion back to the courier's balance. Events for accounts or
 * transfers this Market does not hold are recorded and ignored.
 */
@Injectable()
export class HandleProviderWebhook {
  constructor(
    @Inject(PROVIDER_WEBHOOK_VERIFIER) private readonly verifier: ProviderWebhookVerifier,
    @Inject(PAYOUT_ACCOUNT_REPOSITORY) private readonly accounts: PayoutAccountRepository,
    @Inject(PAYOUT_RUN_REPOSITORY) private readonly runs: PayoutRunRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  run(
    market: MarketContext,
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): Promise<Result<WebhookOutcome, PayoutsFailure>> {
    const verified = this.verifier.verify(rawBody, signatureHeader, this.clock.now());
    if (!verified.ok) {
      return Promise.resolve(
        err({
          code: `payouts.webhook-${verified.error}`,
          message: 'The webhook was not signed by the payment provider',
        }),
      );
    }
    const event = verified.value;
    return refusingBrokenRules(() =>
      this.unitOfWork.run(market, async () => {
        const now = this.clock.now();
        if (!(await this.accounts.recordProviderEvent(market, event.id, event.type, now))) {
          return ok('duplicate' as const);
        }
        return ok(await this.apply(market, event, now));
      }),
    );
  }

  private async apply(
    market: MarketContext,
    event: ProviderEvent,
    now: ReturnType<Clock['now']>,
  ): Promise<WebhookOutcome> {
    if (event.kind === 'account-updated') {
      const account = await this.accounts.findByProviderAccount(market, event.accountId);
      if (account === undefined) return 'ignored';
      if (account.payoutsEnabled !== event.payoutsEnabled) {
        await this.accounts.update(market, {
          ...account,
          payoutsEnabled: event.payoutsEnabled,
          updatedAt: now,
        });
      }
      return 'applied';
    }
    if (event.kind === 'transfer-reversed') {
      const line = await this.runs.findLineByTransfer(market, event.transferId);
      if (line === undefined || line.amount.currency !== event.currency) return 'ignored';
      const reversed = lineReversed(line, money(event.amountReversed, event.currency), now);
      if (reversed.newlyReversed.amount === 0n) return 'applied';
      await this.runs.updateLine(market, reversed.line);
      const debit = await this.ledger.findByReference(market, `payout:${line.id}`);
      if (debit !== undefined) {
        await this.ledger.append(market, [
          reversalOf(debit, {
            id: this.ids.next<'LedgerEntry'>(),
            reference: `transfer-reversal:${line.id}:${event.amountReversed}`,
            reason: 'transfer-reversed',
            portion: reversed.newlyReversed,
            occurredAt: now,
            recordedAt: now,
          }),
        ]);
      }
      return 'applied';
    }
    return 'ignored';
  }
}
