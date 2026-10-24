import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { earningFor, type CompletedDelivery, type EarningBreakdown } from '../../domain/earnings';
import { earningEntry, type LedgerEntry } from '../../domain/ledger';
import { payTaxOn } from '../../domain/tax';
import { refusingBrokenRules, unknownCourier, type PayoutsFailure } from '../failure';
import {
  LEDGER_REPOSITORY,
  PAYEE_DIRECTORY,
  PAYOUT_SETTINGS,
  type LedgerRepository,
  type PayeeDirectory,
  type PayoutSettingsProvider,
} from '../ports';

export interface RecordedEarning {
  /** False when this delivery was already recorded: nothing changed. */
  readonly recorded: boolean;
  readonly earning: EarningBreakdown;
  /** The ledger entry, for a contractor whose delivery earned something. */
  readonly entry?: LedgerEntry;
}

/**
 * Records what a courier earned for a delivered delivery, once per delivery: the delivery record
 * for reporting (every courier) and, for a contractor, the earning in the ledger with the tax on
 * it. Called with the delivery module's DELIVERED fact; a repeated fact changes nothing.
 */
@Injectable()
export class RecordDeliveryEarning {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(PAYEE_DIRECTORY) private readonly payees: PayeeDirectory,
    @Inject(PAYOUT_SETTINGS) private readonly settings: PayoutSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async run(
    market: MarketContext,
    delivery: CompletedDelivery,
  ): Promise<Result<RecordedEarning, PayoutsFailure>> {
    const settings = this.settings.get(market.marketId);
    // The payee is read before the unit opens: no other module is called inside it.
    const payee = (await this.payees.payees(market, [delivery.courierId])).get(delivery.courierId);
    if (payee === undefined) return err(unknownCourier(delivery.courierId));
    const id = this.ids.next<'LedgerEntry'>();

    return refusingBrokenRules(async () => {
      const earning = earningFor(settings, payee.engagement, delivery);
      const now = this.clock.now();
      const entry =
        earning.total.amount > 0n
          ? earningEntry({
              id,
              courierId: delivery.courierId,
              deliveryId: delivery.deliveryId,
              amount: earning.total,
              tax: payTaxOn(settings, payee, 'service', earning.total),
              occurredAt: delivery.deliveredAt,
              recordedAt: now,
            })
          : undefined;
      return this.unitOfWork.run<RecordedEarning, PayoutsFailure>(market, async () => {
        const recorded = await this.ledger.recordDelivery(market, {
          delivery,
          engagement: payee.engagement,
          earning,
          recordedAt: now,
        });
        if (!recorded) return ok({ recorded: false, earning });
        if (entry !== undefined) await this.ledger.append(market, [entry]);
        return ok({ recorded: true, earning, ...(entry === undefined ? {} : { entry }) });
      });
    });
  }
}
