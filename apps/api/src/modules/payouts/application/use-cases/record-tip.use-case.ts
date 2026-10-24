import {
  err,
  ok,
  type CallContext,
  type Money,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PayoutsDomainError } from '../../domain/errors';
import { tipEntry } from '../../domain/ledger';
import { payTaxOn } from '../../domain/tax';
import { isSystem } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import {
  ACCESS_DENIED,
  refusingBrokenRules,
  unknownCourier,
  type PayoutsFailure,
  type RecordedEntry,
} from '../failure';

export interface TipInput {
  readonly deliveryId: string;
  readonly courierId: string;
  readonly amount: Money;
  readonly occurredAt: Temporal.Instant;
}

/**
 * Credits a tip on a delivery to its courier, once per delivery. The whole tip goes to the
 * courier; it carries tax only where the Market taxes tips. An employee's tips are recorded too
 * and reach payroll through the held payout line. Rule `system`: the marketplace's tip arrives
 * through an event subscriber.
 */
export class RecordTip extends UseCase<TipInput, RecordedEntry, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.record-tip',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    tip: TipInput,
  ): Promise<Result<RecordedEntry, PayoutsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { ledger, payees, unitOfWork, clock, ids } = this.deps;
    const settings = this.deps.settings.get(market.marketId);
    const payee = (await payees.payees(context, [tip.courierId])).get(tip.courierId);
    if (payee === undefined) return err(unknownCourier(tip.courierId));
    const id = ids.next<'LedgerEntry'>();

    return refusingBrokenRules(async () => {
      if (tip.amount.currency !== settings.currency) {
        throw new PayoutsDomainError(
          'payouts.currency-mismatch',
          `Tips in this Market are in ${settings.currency}`,
        );
      }
      const entry = tipEntry({
        id,
        courierId: tip.courierId,
        deliveryId: tip.deliveryId,
        amount: tip.amount,
        tax: payTaxOn(settings, payee, 'tip', tip.amount),
        occurredAt: tip.occurredAt,
        recordedAt: clock.now(),
      });
      return unitOfWork.run<RecordedEntry, PayoutsFailure>(market, async () => {
        if ((await ledger.append(market, [entry])) === 1) return ok({ recorded: true, entry });
        const existing = await ledger.findByReference(market, entry.reference);
        return ok({ recorded: false, entry: existing ?? entry });
      });
    });
  }
}
