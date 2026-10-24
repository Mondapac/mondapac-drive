import { err, ok, type CallContext, type Result, type Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { earningFor, type CompletedDelivery, type EarningBreakdown } from '../../domain/earnings';
import { earningEntry, type LedgerEntry } from '../../domain/ledger';
import { payTaxOn } from '../../domain/tax';
import { isSystem } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import {
  ACCESS_DENIED,
  refusingBrokenRules,
  unknownCourier,
  type PayoutsFailure,
} from '../failure';

export interface DeliveredInput {
  readonly deliveryId: string;
  /** The courier who delivered it: its identity account id. */
  readonly courierId: string;
  readonly deliveredAt: Temporal.Instant;
  /** The event delivery of the subscriber that calls: the unit then records it once. */
  readonly event?: EventDelivery;
}

export interface RecordedEarning {
  /** False when this delivery was already recorded: nothing changed. */
  readonly recorded: boolean;
  readonly earning?: EarningBreakdown;
  /** The ledger entry, for a contractor whose delivery earned something. */
  readonly entry?: LedgerEntry;
}

/**
 * Records what a courier earned for a delivered delivery, once per delivery: the delivery record
 * for reporting (every courier) and, for a contractor, the earning in the ledger with the tax on
 * it. Called by the subscriber of delivery's DELIVERED status change; a repeated event changes
 * nothing. Fleet (the payee) and delivery (vehicle, distance, temperature) are read before the
 * unit opens. Waiting time is not reported by delivery yet, so none is paid. Rule `system`.
 */
export class RecordDeliveryEarning extends UseCase<DeliveredInput, RecordedEarning, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.record-delivery-earning',
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
    input: DeliveredInput,
  ): Promise<Result<RecordedEarning, PayoutsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { ledger, payees, deliveries, settings: provider, unitOfWork, clock, ids } = this.deps;
    const settings = provider.get(market.marketId);
    const payee = (await payees.payees(context, [input.courierId])).get(input.courierId);
    if (payee === undefined) return err(unknownCourier(input.courierId));
    const facts = await deliveries.factsOf(context, input.deliveryId);
    if (facts === undefined) {
      return err({ code: 'payouts.unknown-delivery', message: 'Delivery knows no such delivery' });
    }
    const delivery: CompletedDelivery = {
      deliveryId: input.deliveryId,
      courierId: input.courierId,
      vehicle: facts.vehicle,
      distanceMetres: facts.distanceMetres,
      temperature: facts.temperature,
      deliveredAt: input.deliveredAt,
    };
    const id = ids.next<'LedgerEntry'>();

    return refusingBrokenRules(async () => {
      const earning = earningFor(settings, payee.engagement, delivery);
      const now = clock.now();
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
      const work = async (): Promise<Result<RecordedEarning, PayoutsFailure>> => {
        const recorded = await ledger.recordDelivery(market, {
          delivery,
          engagement: payee.engagement,
          earning,
          recordedAt: now,
        });
        if (!recorded) return ok({ recorded: false, earning });
        if (entry !== undefined) await ledger.append(market, [entry]);
        return ok({ recorded: true, earning, ...(entry === undefined ? {} : { entry }) });
      };
      if (input.event === undefined) return unitOfWork.run(market, work);
      const once = await unitOfWork.runOnce(market, input.event, work);
      if (!once.ok) return once;
      return ok(once.value.handled ? once.value.value : { recorded: false });
    });
  }
}
