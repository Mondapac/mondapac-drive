import {
  err,
  money,
  ok,
  type CallContext,
  type Id,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { accountUpdated, lineReversed } from '../../domain/payout-run';
import type { PayoutsDependencies } from '../dependencies';
import { refusingBrokenRules, type PayoutsFailure } from '../failure';
import type { ProviderEvent } from '../ports';

/** What a webhook did: acted, found nothing of this Market to act on, or saw the event before. */
export type WebhookOutcome = 'applied' | 'ignored' | 'duplicate';

/**
 * What operators must look at, logged by the route (codes and ids only):
 * - `reversal-unmatched`: a reversal of a transfer this Market sent, whose line has no such
 *   transfer yet. Answered non-2xx, so the provider retries until the line is settled.
 * - `reversal-foreign`: a reversal of a transfer Drive did not send (no Drive metadata).
 * - `reversal-currency-mismatch`: the reversal's currency is not the line's.
 */
export type WebhookAlert = 'reversal-unmatched' | 'reversal-foreign' | 'reversal-currency-mismatch';

export interface WebhookResult {
  readonly outcome: WebhookOutcome;
  readonly alert?: WebhookAlert;
  /** The provider's transfer and the line, for the alert's log line. */
  readonly transferId?: string;
  readonly lineId?: string;
}

export interface WebhookInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
}

/** The code of a webhook the provider must send again later (the route answers 503). */
export const RETRY_LATER = 'payouts.webhook-retry-later';

/** A refusal: a bad signature or body, a broken rule, or "retry later" with its alert. */
export type WebhookRefusal = PayoutsFailure & Omit<WebhookResult, 'outcome'>;

/**
 * Handles one payment-provider webhook for a Market: verifies its signature over the raw body,
 * records the event id once (a redelivery does nothing), and applies what payouts acts on.
 *
 * - An account update sets whether the courier's account can be paid out, unless the state
 *   stored is newer than the event (reports arrive in no order, security review L1).
 * - A transfer reversal marks its line with the reversed total, credited to no balance: payouts
 *   never reverses a transfer itself, so one comes from an operator at the provider, usually a
 *   clawback, and crediting it would pay it out again in the next run. An operator who means
 *   the courier to be paid again records an adjustment. A reversal of a transfer this Market
 *   sent whose line does not hold it yet (the transfer's answer was lost, the line is still
 *   pending or unresolved) is not recorded and answers "retry later", so it is applied once
 *   the line is settled (security review M2). A reversal in another currency than its line's
 *   is recorded with an alert.
 *
 * A transfer of another Market, and an event payouts does not act on, are recorded and ignored.
 * Rule `anonymous`: the provider has no session; the signature is the authentication.
 */
export class HandleProviderWebhook extends UseCase<WebhookInput, WebhookResult, WebhookRefusal> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.handle-provider-webhook',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: WebhookInput,
  ): Promise<Result<WebhookResult, WebhookRefusal>> {
    const { market } = context;
    const { verifier, accounts, unitOfWork, clock } = this.deps;
    const verified = verifier.verify(input.rawBody, input.signatureHeader, clock.now());
    if (!verified.ok) {
      return err({
        code: `payouts.webhook-${verified.error}`,
        message: 'The webhook was not signed by the payment provider',
      });
    }
    const event = verified.value;
    return refusingBrokenRules(() =>
      unitOfWork.run<WebhookResult, WebhookRefusal>(market, async () => {
        const now = clock.now();
        if (!(await accounts.recordProviderEvent(market, event.id, event.type, now))) {
          return ok({ outcome: 'duplicate' });
        }
        // An `err` commits nothing of the unit, the event id included: the redelivery is handled.
        return this.apply(context, event, now);
      }),
    );
  }

  private async apply(
    context: CallContext,
    event: ProviderEvent,
    now: Temporal.Instant,
  ): Promise<Result<WebhookResult, WebhookRefusal>> {
    const { market } = context;
    const { accounts, runs } = this.deps;
    if (event.kind === 'account-updated') {
      const account = await accounts.findByProviderAccount(market, event.accountId);
      if (account === undefined) return ok({ outcome: 'ignored' });
      const updated = accountUpdated(
        account,
        { payoutsEnabled: event.payoutsEnabled, stateAt: event.created },
        now,
      );
      if (updated === undefined) return ok({ outcome: 'ignored' });
      await accounts.update(market, updated);
      return ok({ outcome: 'applied' });
    }
    if (event.kind === 'transfer-reversed') {
      const { transferId } = event;
      if (event.marketId !== undefined && event.marketId !== market.marketId) {
        return ok({ outcome: 'ignored' });
      }
      const line = await runs.findLineByTransfer(market, transferId);
      if (line === undefined) {
        if (event.marketId === undefined) {
          return ok({ outcome: 'ignored', alert: 'reversal-foreign', transferId });
        }
        const byId =
          event.payoutLineId === undefined
            ? undefined
            : await runs.findLine(market, event.payoutLineId as Id<'PayoutLine'>);
        return err({
          code: RETRY_LATER,
          message: 'The transfer of this reversal is not on its line yet; send it again later',
          alert: 'reversal-unmatched',
          transferId,
          ...(byId === undefined ? {} : { lineId: byId.id }),
        });
      }
      if (line.amount.currency !== event.currency) {
        return ok({
          outcome: 'ignored',
          alert: 'reversal-currency-mismatch',
          transferId,
          lineId: line.id,
        });
      }
      const reversed = lineReversed(line, money(event.amountReversed, event.currency), now);
      if (reversed.newlyReversed.amount > 0n) await runs.updateLine(market, reversed.line);
      return ok({ outcome: 'applied', transferId, lineId: line.id });
    }
    return ok({ outcome: 'ignored' });
  }
}
