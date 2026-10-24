import { err, ok, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { reversalOf, type LedgerEntry } from '../../domain/ledger';
import { isSystem } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, refusingBrokenRules, type PayoutsFailure } from '../failure';

export interface ReversedDelivery {
  readonly deliveryId: string;
}

/**
 * Takes back what a delivery credited (its earning and tip), for a delivery that is reversed
 * after it was recorded, such as a confirmed fraud. Each entry is reversed once; entries paid
 * out already leave the courier's balance negative until later earnings cover it. Nothing is
 * reversed for a delivery with no entries. Rule `system`.
 */
export class ReverseDeliveryEarning extends UseCase<
  ReversedDelivery,
  { readonly reversals: readonly LedgerEntry[] },
  PayoutsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.reverse-delivery-earning',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ReversedDelivery,
  ): Promise<Result<{ readonly reversals: readonly LedgerEntry[] }, PayoutsFailure>> {
    if (!isSystem(context)) return Promise.resolve(err(ACCESS_DENIED));
    const { market } = context;
    const { ledger, unitOfWork, clock, ids } = this.deps;
    return refusingBrokenRules(() =>
      unitOfWork.run(market, async () => {
        const entries = await ledger.entriesOfDelivery(market, input.deliveryId);
        const reversed = new Set(entries.map((entry) => entry.reversesEntryId));
        const now = clock.now();
        const reversals = entries
          .filter(
            (entry) =>
              (entry.kind === 'earning' || entry.kind === 'tip') && !reversed.has(entry.id),
          )
          .map((entry) =>
            reversalOf(entry, {
              id: ids.next<'LedgerEntry'>(),
              reference: `reversal:${entry.id}`,
              reason: 'delivery-reversed',
              occurredAt: now,
              recordedAt: now,
            }),
          );
        await ledger.append(market, reversals);
        return ok({ reversals });
      }),
    );
  }
}
