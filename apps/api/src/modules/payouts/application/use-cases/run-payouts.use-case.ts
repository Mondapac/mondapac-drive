import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { payoutEntry, reversalOf } from '../../domain/ledger';
import {
  lineRefused,
  lineTransferred,
  planPayoutRun,
  transferAmountOf,
  type PayoutLine,
  type PayoutRun,
} from '../../domain/payout-run';
import { latestCutoff } from '../../domain/payout-schedule';
import { refusingBrokenRules, type PayoutsFailure } from '../failure';
import {
  LEDGER_REPOSITORY,
  PAYEE_DIRECTORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYOUT_GATEWAY,
  PAYOUT_RUN_REPOSITORY,
  PAYOUT_SETTINGS,
  type LedgerRepository,
  type PayeeDirectory,
  type PayoutAccountRepository,
  type PayoutGateway,
  type PayoutRunRepository,
  type PayoutSettingsProvider,
} from '../ports';

/** Pending lines sent per tick; the rest wait for the next one. */
export const TRANSFER_BATCH = 50;

export interface PayoutTick {
  /** The run opened by this tick, if its cutoff had none yet. */
  readonly opened?: PayoutRun;
  /** Transfers the provider accepted, refused for good, and refused for now. */
  readonly transferred: number;
  readonly failed: number;
  readonly retrying: number;
}

/**
 * One tick of the payout job, safe to run twice and concurrently. First it opens the run of the
 * latest closed period, once per cutoff: every courier balance owed before the cutoff becomes a
 * line, and each payable line's amount is debited from the ledger in the same unit. Then it
 * sends up to {@link TRANSFER_BATCH} pending lines to the provider, each with its own
 * idempotency key, and records the outcome; a line refused for good gets its debit reversed, so
 * the balance waits for the next run.
 */
@Injectable()
export class RunPayouts {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(PAYOUT_RUN_REPOSITORY) private readonly runs: PayoutRunRepository,
    @Inject(PAYOUT_ACCOUNT_REPOSITORY) private readonly accounts: PayoutAccountRepository,
    @Inject(PAYEE_DIRECTORY) private readonly payees: PayeeDirectory,
    @Inject(PAYOUT_GATEWAY) private readonly gateway: PayoutGateway,
    @Inject(PAYOUT_SETTINGS) private readonly settings: PayoutSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async run(market: MarketContext): Promise<Result<PayoutTick, PayoutsFailure>> {
    const opened = await this.openDueRun(market);
    if (!opened.ok) return opened;
    const sent = await this.sendPendingLines(market);
    if (!sent.ok) return sent;
    return ok({ ...(opened.value === undefined ? {} : { opened: opened.value }), ...sent.value });
  }

  private async openDueRun(
    market: MarketContext,
  ): Promise<Result<PayoutRun | undefined, PayoutsFailure>> {
    const settings = this.settings.get(market.marketId);
    return refusingBrokenRules(async () => {
      const cutoff = latestCutoff(settings.schedule, settings.timezone, this.clock.now());
      const seen = await this.unitOfWork.run(
        market,
        async () => {
          if (await this.runs.findRunByCutoff(market, cutoff)) return ok(undefined);
          const balances = await this.ledger.balancesBefore(market, cutoff, settings.currency);
          return ok(balances.filter((entry) => entry.balance.total.amount > 0n));
        },
        { readOnly: true },
      );
      if (!seen.ok || seen.value === undefined) return ok(undefined);
      // Fleet is asked before the read-write unit opens: no other module is called inside it.
      const payees = await this.payees.payees(
        market,
        seen.value.map((entry) => entry.courierId),
      );

      return this.unitOfWork.run(market, async () => {
        if (await this.runs.findRunByCutoff(market, cutoff)) return ok(undefined);
        const now = this.clock.now();
        const balances = await this.ledger.balancesBefore(market, cutoff, settings.currency);
        const accounts = await this.accounts.findMany(
          market,
          balances.map((entry) => entry.courierId),
        );
        const { run, lines } = planPayoutRun(settings, {
          runId: this.ids.next<'PayoutRun'>(),
          cutoff,
          now,
          balances,
          payees,
          accounts: new Map(accounts.map((account) => [account.courierId, account])),
          newLineId: () => this.ids.next<'PayoutLine'>(),
        });
        if (!(await this.runs.insertRun(market, run, lines))) return ok(undefined);
        const debits = lines
          .filter((line) => line.status === 'pending')
          .map((line) =>
            payoutEntry({
              id: this.ids.next<'LedgerEntry'>(),
              courierId: line.courierId,
              payoutLineId: line.id,
              paid: { amount: line.amount, tax: line.tax, total: transferAmountOf(line) },
              occurredAt: cutoff,
              recordedAt: now,
            }),
          );
        await this.ledger.append(market, debits);
        return ok(run);
      });
    });
  }

  private async sendPendingLines(
    market: MarketContext,
  ): Promise<Result<Omit<PayoutTick, 'opened'>, PayoutsFailure>> {
    const tally = { transferred: 0, failed: 0, retrying: 0 };
    if (!this.gateway.enabled) return ok(tally);
    const pending = await this.unitOfWork.run(
      market,
      async () => ok(await this.runs.pendingLines(market, TRANSFER_BATCH)),
      { readOnly: true },
    );
    if (!pending.ok) return pending;

    for (const line of pending.value) {
      const sent = await this.gateway.createTransfer({
        amount: transferAmountOf(line),
        destination: line.destination!,
        idempotencyKey: `payout-line-${line.id}`,
        metadata: { marketId: market.marketId, payoutLineId: line.id, runId: line.runId },
      });
      const outcome = await refusingBrokenRules(() =>
        this.unitOfWork.run(market, async () => {
          const current = await this.runs.findLine(market, line.id);
          // Another tick recorded this line first: the same key answered it the same transfer.
          if (current?.status !== 'pending') return ok('skipped' as const);
          const now = this.clock.now();
          const next = sent.ok
            ? lineTransferred(current, sent.value.transferId, now)
            : lineRefused(current, sent.error, now);
          await this.runs.updateLine(market, next);
          if (next.status === 'failed') await this.reverseDebit(market, next, now);
          return ok(next.status);
        }),
      );
      if (!outcome.ok) return outcome;
      if (outcome.value === 'transferred') tally.transferred += 1;
      else if (outcome.value === 'failed') tally.failed += 1;
      else if (outcome.value === 'pending') tally.retrying += 1;
    }
    return ok(tally);
  }

  /** Credits back the debit of a line that will never be paid. */
  private async reverseDebit(
    market: MarketContext,
    line: PayoutLine,
    now: PayoutLine['updatedAt'],
  ): Promise<void> {
    const debit = await this.ledger.findByReference(market, `payout:${line.id}`);
    if (debit === undefined) return;
    await this.ledger.append(market, [
      reversalOf(debit, {
        id: this.ids.next<'LedgerEntry'>(),
        reference: `reversal:${debit.id}`,
        reason: 'transfer-failed',
        occurredAt: now,
        recordedAt: now,
      }),
    ]);
  }
}
