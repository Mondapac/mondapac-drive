import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  applyDeliveryEvent,
  type DeliveryEventInput,
  type DeliveryState,
} from '../domain/delivery';
import type { DeliveryEventType } from '../domain/delivery-status';
import { changeEvents } from '../domain/events/delivery-events';
import { refusingBrokenRules, type DeliveryFailure } from './failure';
import type { DeliveryRepository, MarketSettingsProvider } from './ports';

/** The ports the delivery use cases that read or change one delivery take. */
export interface DeliveryAccessDependencies {
  readonly deliveries: DeliveryRepository;
  readonly markets: MarketSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  /** The delivery module's own outbox: every change writes its events in the same unit. */
  readonly outbox: OutboxWriter;
}

/** Who may see or change a delivery: a test on the stored delivery, by the caller's actor. */
export type DeliveryScope = (delivery: DeliveryState) => boolean;

export function notFound(id: string): DeliveryFailure {
  return { code: 'delivery.not-found', message: `No delivery ${id}` };
}

/** The refusal of an actor of the wrong population: the gate's code, never reached from HTTP. */
export const ACCESS_DENIED: DeliveryFailure = Object.freeze({
  code: 'access.denied',
  message: 'Not allowed',
});

/** The merchant of an API-key actor, or null for any other actor. */
export function merchantOf(context: CallContext): Id<'Merchant'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'merchant'
    ? actor.merchantId
    : null;
}

/** The courier's account id of a courier actor, or null for any other actor. */
export function courierOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'courier' ? actor.accountId : null;
}

/** Whether the actor is a signed-in admin (an operator or a dispatcher). */
export function isAdmin(context: CallContext): boolean {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin';
}

/**
 * Reads one delivery in a read-only unit. One outside `scope` answers `delivery.not-found`,
 * byte-identical to a missing one, so an id of another merchant's delivery tells nothing.
 */
export function readDelivery(
  deps: DeliveryAccessDependencies,
  market: MarketContext,
  id: Id<'Delivery'>,
  scope: DeliveryScope,
): Promise<Result<DeliveryState, DeliveryFailure>> {
  return deps.unitOfWork.run(
    market,
    async () => {
      const delivery = await deps.deliveries.findById(market, id);
      return delivery !== undefined && scope(delivery) ? ok(delivery) : err(notFound(id));
    },
    { readOnly: true },
  );
}

/**
 * Saves `next` over `delivery` and writes the events of the change into the delivery outbox,
 * inside the caller's open read-write unit: the state and its events commit together or not at
 * all.
 */
export async function saveChange(
  deps: Pick<DeliveryAccessDependencies, 'deliveries' | 'outbox'>,
  context: CallContext,
  delivery: DeliveryState,
  next: DeliveryState,
  causedBy?: Id,
): Promise<void> {
  await deps.deliveries.update(context.market, next, delivery.version);
  await deps.outbox.append(context, changeEvents(delivery, next), causedBy);
}

/**
 * Records an event on one delivery in one unit: the delivery read, refused as not found outside
 * `scope`, the event type refused unless it is one of `types` (the caller's population's own
 * events), then the domain's transition, the save at the version read and its outbox event.
 */
export function recordEvent(
  deps: DeliveryAccessDependencies,
  context: CallContext,
  id: Id<'Delivery'>,
  event: DeliveryEventInput,
  scope: DeliveryScope,
  types: readonly DeliveryEventType[],
): Promise<Result<DeliveryState, DeliveryFailure>> {
  if (!types.includes(event.type)) {
    return Promise.resolve(
      err({ code: 'delivery.event-not-allowed', message: `You cannot record ${event.type}` }),
    );
  }
  const { market } = context;
  const settings = deps.markets.get(market.marketId);
  return deps.unitOfWork.run(market, () =>
    refusingBrokenRules(async () => {
      const delivery = await deps.deliveries.findById(market, id);
      if (delivery === undefined || !scope(delivery)) return err(notFound(id));
      const next = applyDeliveryEvent(delivery, event, deps.clock.now(), settings);
      await saveChange(deps, context, delivery, next);
      return ok(next);
    }),
  );
}
