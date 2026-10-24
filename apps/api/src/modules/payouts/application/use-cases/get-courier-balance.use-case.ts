import { Inject, Injectable } from '@nestjs/common';
import { ok, type MarketContext, type Result } from '@mondapac-drive/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Balance, LedgerEntry } from '../../domain/ledger';
import type { PayoutsFailure } from '../failure';
import {
  LEDGER_REPOSITORY,
  PAYOUT_SETTINGS,
  type LedgerRepository,
  type PayoutSettingsProvider,
} from '../ports';

export interface CourierStatement {
  readonly balance: Balance;
  /** The latest entries, newest first. */
  readonly entries: readonly LedgerEntry[];
}

/** A courier's balance and latest ledger entries, for the courier app and operators. */
@Injectable()
export class GetCourierBalance {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(PAYOUT_SETTINGS) private readonly settings: PayoutSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  run(
    market: MarketContext,
    courierId: string,
    limit = 50,
  ): Promise<Result<CourierStatement, PayoutsFailure>> {
    const currency = this.settings.get(market.marketId).currency;
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.unitOfWork.run(
      market,
      async () =>
        ok({
          balance: await this.ledger.balanceOf(market, courierId, currency),
          entries: await this.ledger.recentEntries(market, courierId, bounded),
        }),
      { readOnly: true },
    );
  }
}
