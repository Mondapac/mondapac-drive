import { err, ok, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { eventsOfLine } from '../../domain/events';
import { payoutEntry } from '../../domain/ledger';
import {
  lineHeldBeforeTransfer,
  lineRefused,
  lineTransferred,
  planPayoutRun,
  transferAmountOf,
  type PayoutRun,
} from '../../domain/payout-run';
import { latestCutoff } from '../../domain/payout-schedule';
import { isSystem } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, refusingBrokenRules, type PayoutsFailure } from '../failure';
import { reverseDebitOf } from '../line-debits';

/** Pending lines sent per tick; the rest wait for the next one. */
export const TRANSFER_BATCH = 50;

export interface PayoutTick {
  /** The run opened by this tick, if its cutoff had none yet. */
  readonly opened?: PayoutRun;
  /** Transfers the provider accepted, refused for good, and refused for now. */
  readonly transferred: number;
  readonly failed: number;
  readonly retrying: number;
  /** Lines out of attempts on transient refusals, left for an operator to settle. */
  readonly unresolved: number;
  /** Pending lines held at sending: their account could no longer be paid out (L5). */
  readonly held: number;
}

/**
 * One tick of the payout job, safe to run twice and concurrently. First it opens the run of the
 * latest closed period, once per cutoff: every courier balance owed before the cutoff becomes a
 * line, and each payable line's amount is debited from the ledger in the same unit. Then it
 * sends up to {@link TRANSFER_BATCH} pending lines to the provider, each with its own
 * idempotency key, and records the outcome; a line refused for good gets its debit reversed, so
 * the balance waits for the next run. A line out of attempts on transient refusals keeps its
 * debit: the provider may have made the transfer, and paying the balance again under a new line
 * (a new idempotency key) could pay the courier twice. Just before a line is sent, its account
 * is read again: one that can no longer be paid out holds the line and reverses its debit
 * (security review L5). Transfers and failures publish `payouts.line-*` events. Rule `system`.
 */
export class RunPayouts extends UseCase<Record<string, never>, PayoutTick, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.run-payouts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<PayoutTick, PayoutsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const opened = await this.openDueRun(context);
    if (!opened.ok) return opened;
    const sent = await this.sendPendingLines(context);
    if (!sent.ok) return sent;
    return ok({ ...(opened.value === undefined ? {} : { opened: opened.value }), ...sent.value });
  }

  private async openDueRun(
    context: CallContext,
  ): Promise<Result<PayoutRun | undefined, PayoutsFailure>> {
    const { market } = context;
    const { ledger, runs, accounts, payees, unitOfWork, clock, ids } = this.deps;
    const settings = this.deps.settings.get(market.marketId);
    return refusingBrokenRules(async () => {
      const cutoff = latestCutoff(settings.schedule, settings.timezone, clock.now());
      const seen = await unitOfWork.run(
        market,
        async () => {
          if (await runs.findRunByCutoff(market, cutoff)) return ok(undefined);
          const balances = await ledger.balancesBefore(market, cutoff, settings.currency);
          return ok(balances.filter((entry) => entry.balance.total.amount > 0n));
        },
        { readOnly: true },
      );
      if (!seen.ok || seen.value === undefined) return ok(undefined);
      // Fleet is asked before the read-write unit opens: no other module is called inside it.
      const found = await payees.payees(
        context,
        seen.value.map((entry) => entry.courierId),
      );

      return unitOfWork.run(market, async () => {
        if (await runs.findRunByCutoff(market, cutoff)) return ok(undefined);
        const now = clock.now();
        const balances = await ledger.balancesBefore(market, cutoff, settings.currency);
        const stored = await accounts.findMany(
          market,
          balances.map((entry) => entry.courierId),
        );
        const { run, lines } = planPayoutRun(settings, {
          runId: ids.next<'PayoutRun'>(),
          cutoff,
          now,
          balances,
          payees: found,
          accounts: new Map(stored.map((account) => [account.courierId, account])),
          newLineId: () => ids.next<'PayoutLine'>(),
        });
        if (!(await runs.insertRun(market, run, lines))) return ok(undefined);
        const debits = lines
          .filter((line) => line.status === 'pending')
          .map((line) =>
            payoutEntry({
              id: ids.next<'LedgerEntry'>(),
              courierId: line.courierId,
              payoutLineId: line.id,
              paid: { amount: line.amount, tax: line.tax, total: transferAmountOf(line) },
              occurredAt: cutoff,
              recordedAt: now,
            }),
          );
        await ledger.append(market, debits);
        return ok(run);
      });
    });
  }

  private async sendPendingLines(
    context: CallContext,
  ): Promise<Result<Omit<PayoutTick, 'opened'>, PayoutsFailure>> {
    const { market } = context;
    const { ledger, runs, accounts, gateway, outbox, unitOfWork, clock, ids } = this.deps;
    const tally = { transferred: 0, failed: 0, retrying: 0, unresolved: 0, held: 0 };
    if (!gateway.enabled) return ok(tally);
    const pending = await unitOfWork.run(
      market,
      async () => ok(await runs.pendingLines(market, TRANSFER_BATCH)),
      { readOnly: true },
    );
    if (!pending.ok) return pending;

    for (const line of pending.value) {
      // L5: the account as it is now. Disabled since the run opened: hold, never send.
      const account = await unitOfWork.run(
        market,
        async () => ok(await accounts.find(market, line.courierId)),
        { readOnly: true },
      );
      if (!account.ok) return account;
      const payable =
        account.value?.payoutsEnabled === true &&
        account.value.providerAccountId === line.destination;
      const sent = payable
        ? await gateway.createTransfer({
            amount: transferAmountOf(line),
            destination: line.destination,
            idempotencyKey: `payout-line-${line.id}`,
            metadata: { marketId: market.marketId, payoutLineId: line.id, runId: line.runId },
          })
        : undefined;
      const outcome = await refusingBrokenRules(() =>
        unitOfWork.run(market, async () => {
          const current = await runs.findLine(market, line.id);
          // Another tick recorded this line first: the same key answered it the same transfer.
          if (current?.status !== 'pending') return ok('skipped' as const);
          const now = clock.now();
          const next =
            sent === undefined
              ? lineHeldBeforeTransfer(current, 'payouts-disabled', now)
              : sent.ok
                ? lineTransferred(current, sent.value.transferId, now)
                : lineRefused(current, sent.error, now);
          await runs.updateLine(market, next);
          if (next.status === 'failed' || next.status === 'held') {
            const reversal = await reverseDebitOf(ledger, market, next, {
              id: ids.next<'LedgerEntry'>(),
              reason: next.status === 'held' ? 'payout-held' : 'transfer-failed',
              at: now,
            });
            if (reversal !== undefined) await ledger.append(market, [reversal]);
          }
          await outbox.append(context, eventsOfLine(next));
          return ok(next.status);
        }),
      );
      if (!outcome.ok) return outcome;
      if (outcome.value === 'transferred') tally.transferred += 1;
      else if (outcome.value === 'failed') tally.failed += 1;
      else if (outcome.value === 'pending') tally.retrying += 1;
      else if (outcome.value === 'unresolved') tally.unresolved += 1;
      else if (outcome.value === 'held') tally.held += 1;
    }
    return ok(tally);
  }
}
