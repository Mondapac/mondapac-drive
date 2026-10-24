import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PayoutsDomainError } from '../../domain/errors';
import { adjustmentEntry, type AdjustmentReason } from '../../domain/ledger';
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

export interface AdjustmentInput {
  readonly courierId: string;
  /** Positive credits the courier, negative debits; before tax. */
  readonly amount: Money;
  readonly reason: AdjustmentReason;
  /** The operator's idempotency key: a retry with the same key records nothing new. */
  readonly key: string;
}

const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

/**
 * An operator's credit or debit to a courier's balance, such as a bonus or a correction. It
 * occurs now and carries the tax a service payment would. The operator route arrives with the
 * admin population (identity work package 2).
 */
@Injectable()
export class RecordAdjustment {
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
    adjustment: AdjustmentInput,
  ): Promise<Result<RecordedEntry, PayoutsFailure>> {
    const settings = this.settings.get(market.marketId);
    const payee = (await this.payees.payees(market, [adjustment.courierId])).get(
      adjustment.courierId,
    );
    if (payee === undefined) return err(unknownCourier(adjustment.courierId));
    const id = this.ids.next<'LedgerEntry'>();

    return refusingBrokenRules(async () => {
      if (!KEY.test(adjustment.key)) {
        throw new PayoutsDomainError(
          'payouts.invalid-key',
          'An idempotency key is 8 to 100 letters, digits or ._:-',
        );
      }
      if (adjustment.amount.currency !== settings.currency) {
        throw new PayoutsDomainError(
          'payouts.currency-mismatch',
          `Adjustments in this Market are in ${settings.currency}`,
        );
      }
      const now = this.clock.now();
      const entry = adjustmentEntry({
        id,
        courierId: adjustment.courierId,
        key: adjustment.key,
        amount: adjustment.amount,
        tax: payTaxOn(settings, payee, 'service', adjustment.amount),
        reason: adjustment.reason,
        occurredAt: now,
        recordedAt: now,
      });
      return this.unitOfWork.run<RecordedEntry, PayoutsFailure>(market, async () => {
        if ((await this.ledger.append(market, [entry])) === 1) return ok({ recorded: true, entry });
        const existing = await this.ledger.findByReference(market, entry.reference);
        if (existing !== undefined && existing.courierId !== entry.courierId) {
          return err({
            code: 'payouts.key-reused',
            message: 'This idempotency key was used for another courier',
          });
        }
        return ok({ recorded: false, entry: existing ?? entry });
      });
    });
  }
}
