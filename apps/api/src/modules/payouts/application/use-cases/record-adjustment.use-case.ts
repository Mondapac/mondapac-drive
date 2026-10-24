import {
  err,
  ok,
  type CallContext,
  type Id,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ADJUSTMENT_RECORD } from '../../contracts/permissions';
import { adjustmentRecorded } from '../../domain/audit-actions';
import { PayoutsDomainError } from '../../domain/errors';
import { adjustmentEntry, type AdjustmentReason } from '../../domain/ledger';
import { payTaxOn } from '../../domain/tax';
import { isAdmin } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import {
  ACCESS_DENIED,
  refusingBrokenRules,
  unknownCourier,
  type PayoutsFailure,
  type RecordedEntry,
} from '../failure';

export interface AdjustmentInput {
  readonly courierId: string;
  /** Positive credits the courier, negative debits; before tax. */
  readonly amount: Money;
  readonly reason: AdjustmentReason;
  /** The operator's idempotency key: a retry with the same key records nothing new. */
  readonly key: string;
}

const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

/** The largest adjustment, either way, in minor units: a bound against a typo, not a policy. */
export const MAX_ADJUSTMENT_MINOR = 100_000_000n;

/**
 * An operator's credit or debit to a courier's balance, such as a bonus or a correction. It
 * occurs now and carries the tax a service payment would. Audited in the same unit with the
 * operator, the amounts and the reason. Rule `permissions [payouts.adjustment.record]`
 * (protected), admins only.
 */
export class RecordAdjustment extends UseCase<AdjustmentInput, RecordedEntry, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.record-adjustment',
    rule: { kind: 'permissions', allOf: [ADJUSTMENT_RECORD.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    adjustment: AdjustmentInput,
  ): Promise<Result<RecordedEntry, PayoutsFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { ledger, payees, audit, unitOfWork, clock, ids } = this.deps;
    const settings = this.deps.settings.get(market.marketId);
    const payee = (await payees.payees(context, [adjustment.courierId])).get(
      adjustment.courierId,
    );
    if (payee === undefined) return err(unknownCourier(adjustment.courierId));
    const id = ids.next<'LedgerEntry'>();

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
      const size = adjustment.amount.amount < 0n ? -adjustment.amount.amount : adjustment.amount.amount;
      if (size > MAX_ADJUSTMENT_MINOR) {
        throw new PayoutsDomainError('payouts.adjustment-too-large', 'The adjustment is too large');
      }
      const now = clock.now();
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
      return unitOfWork.run<RecordedEntry, PayoutsFailure>(market, async () => {
        if ((await ledger.append(market, [entry])) === 1) {
          await audit.record(
            context,
            adjustmentRecorded.entry(adjustment.courierId as Id, {
              after: {
                entryId: entry.id,
                amount: entry.amount,
                tax: entry.tax,
                reason: adjustment.reason,
              },
            }),
          );
          return ok({ recorded: true, entry });
        }
        const existing = await ledger.findByReference(market, entry.reference);
        if (
          existing === undefined ||
          existing.courierId !== entry.courierId ||
          existing.amount.amount !== entry.amount.amount
        ) {
          return err({
            code: 'payouts.key-reused',
            message: 'This idempotency key was used for another adjustment',
          });
        }
        return ok({ recorded: false, entry: existing });
      });
    });
  }
}
