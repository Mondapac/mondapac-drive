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
import { reversalOf, type LedgerEntry } from '../../domain/ledger';
import { refusingBrokenRules, type PayoutsFailure } from '../failure';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../ports';

/**
 * Takes back what a delivery credited (its earning and tip), for a delivery that is reversed
 * after it was recorded, such as a confirmed fraud. Each entry is reversed once; entries paid
 * out already leave the courier's balance negative until later earnings cover it. Nothing is
 * reversed for a delivery with no entries.
 */
@Injectable()
export class ReverseDeliveryEarning {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  run(
    market: MarketContext,
    deliveryId: string,
  ): Promise<Result<{ readonly reversals: readonly LedgerEntry[] }, PayoutsFailure>> {
    return refusingBrokenRules(() =>
      this.unitOfWork.run(market, async () => {
        const entries = await this.ledger.entriesOfDelivery(market, deliveryId);
        const reversed = new Set(entries.map((entry) => entry.reversesEntryId));
        const now = this.clock.now();
        const reversals = entries
          .filter(
            (entry) =>
              (entry.kind === 'earning' || entry.kind === 'tip') && !reversed.has(entry.id),
          )
          .map((entry) =>
            reversalOf(entry, {
              id: this.ids.next<'LedgerEntry'>(),
              reference: `reversal:${entry.id}`,
              reason: 'delivery-reversed',
              occurredAt: now,
              recordedAt: now,
            }),
          );
        await this.ledger.append(market, reversals);
        return ok({ reversals });
      }),
    );
  }
}
