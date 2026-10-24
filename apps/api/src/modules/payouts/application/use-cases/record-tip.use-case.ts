import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Money,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PayoutsDomainError } from '../../domain/errors';
import { tipEntry } from '../../domain/ledger';
import { payTaxOn } from '../../domain/tax';
import {
  refusingBrokenRules,
  unknownCourier,
  type PayoutsFailure,
  type RecordedEntry,
} from '../failure';
import {
  LEDGER_REPOSITORY,
  PAYEE_DIRECTORY,
  PAYOUT_SETTINGS,
  type LedgerRepository,
  type PayeeDirectory,
  type PayoutSettingsProvider,
} from '../ports';

export interface TipInput {
  readonly deliveryId: string;
  readonly courierId: string;
  readonly amount: Money;
  readonly occurredAt: Temporal.Instant;
}

/**
 * Credits a tip on a delivery to its courier, once per delivery. The whole tip goes to the
 * courier; it carries tax only where the Market taxes tips. An employee's tips are recorded too
 * and reach payroll through the held payout line.
 */
@Injectable()
export class RecordTip {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(PAYEE_DIRECTORY) private readonly payees: PayeeDirectory,
    @Inject(PAYOUT_SETTINGS) private readonly settings: PayoutSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async run(market: MarketContext, tip: TipInput): Promise<Result<RecordedEntry, PayoutsFailure>> {
    const settings = this.settings.get(market.marketId);
    const payee = (await this.payees.payees(market, [tip.courierId])).get(tip.courierId);
    if (payee === undefined) return err(unknownCourier(tip.courierId));
    const id = this.ids.next<'LedgerEntry'>();

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
        recordedAt: this.clock.now(),
      });
      return this.unitOfWork.run<RecordedEntry, PayoutsFailure>(market, async () => {
        if ((await this.ledger.append(market, [entry])) === 1) return ok({ recorded: true, entry });
        const existing = await this.ledger.findByReference(market, entry.reference);
        return ok({ recorded: false, entry: existing ?? entry });
      });
    });
  }
}
