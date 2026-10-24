import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../events/event-delivery';
import type { MarketTransaction } from '../guarded-client';
import type { ModelMap } from '../model-map';

/** `runOnce` was given a delivery the dispatcher did not hand out, or one of another Market. */
export class UnknownDeliveryError extends Error {
  override readonly name = 'UnknownDeliveryError';
  constructor() {
    super('runOnce takes only a delivery the dispatcher handed out, in its own Market');
  }
}

/** What the dispatcher knows of a delivery it handed out; never reachable from a module. */
interface IssuedDelivery {
  readonly market: MarketContext;
  /** The module that owns the inbox: the first segment of the subscriber's name. */
  readonly module: string;
  /** The dispatcher's clock: the instant of the inbox row and of `delivered_at`. */
  readonly now: () => Temporal.Instant;
  settled: boolean;
}

/**
 * Deliveries the dispatcher handed out (platform persistence design, "P", 6.4). Keyed by the
 * frozen object itself, so a copy, a spread or a value rebuilt from its fields is unknown and
 * `runOnce` refuses it. Only `platform/persistence/` reads this file.
 */
const issued = new WeakMap<EventDelivery, IssuedDelivery>();

/** Creates the delivery handle of one claim. Called by the dispatcher only. */
export function issueDelivery(
  fields: { readonly eventId: Id<'event'>; readonly subscriber: string; readonly attempt: number },
  market: MarketContext,
  now: () => Temporal.Instant,
): EventDelivery {
  const delivery: EventDelivery = Object.freeze({
    eventId: fields.eventId,
    subscriber: fields.subscriber,
    attempt: fields.attempt,
  });
  const module = fields.subscriber.slice(0, fields.subscriber.indexOf('.'));
  issued.set(delivery, { market, module, now, settled: false });
  return delivery;
}

/** Whether a `runOnce` of this delivery committed (P 6.4: otherwise the handler failed). */
export function deliverySettled(delivery: EventDelivery): boolean {
  return issued.get(delivery)?.settled === true;
}

/** The record of a delivery for `runOnce`; throws when it is unknown or of another Market. */
export function issuedDeliveryFor(delivery: EventDelivery, market: MarketContext): IssuedDelivery {
  const record = issued.get(delivery);
  if (
    record === undefined ||
    record.market.marketId !== market.marketId ||
    record.market.tenantId !== market.tenantId
  ) {
    throw new UnknownDeliveryError();
  }
  return record;
}

/** Marks a delivery settled once its `runOnce` committed. */
export function settleDelivery(delivery: EventDelivery): void {
  const record = issued.get(delivery);
  if (record !== undefined) record.settled = true;
}

type InboxDelegate = {
  createMany(args: { data: readonly object[]; skipDuplicates: true }): Promise<{ count: number }>;
};

/**
 * Inserts `(event_id, handler)` into the inbox of the subscriber's module, through the open
 * unit's guarded view, ignoring a repeated key (ADR-0006 decision 5). Answers whether the row
 * is new, so the work runs once per event and handler. The module's inbox model comes from the
 * model map (P 9, the named exception of this folder).
 */
export async function recordInInbox(
  view: MarketTransaction,
  map: ModelMap,
  delivery: EventDelivery,
  record: IssuedDelivery,
): Promise<boolean> {
  const inboxModel = map.modules[record.module]?.inboxModel ?? null;
  const entry = inboxModel === null ? undefined : map.models[inboxModel];
  if (entry === undefined || entry.module !== record.module) {
    throw new Error(`Module "${record.module}" has no inbox model in its schema file`);
  }
  const inbox = (view as unknown as Record<string, InboxDelegate>)[entry.clientProperty]!;
  const { count } = await inbox.createMany({
    data: [
      {
        eventId: delivery.eventId,
        handler: delivery.subscriber,
        marketId: record.market.marketId,
        tenantId: record.market.tenantId,
        processedAt: new Date(record.now().epochMilliseconds),
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

/**
 * Marks the delivery `delivered`, in the same unit as the inbox row and the work, when it is
 * still pending (a dead row stays dead).
 */
export async function markDelivered(
  view: MarketTransaction,
  delivery: EventDelivery,
  record: IssuedDelivery,
): Promise<void> {
  await view.eventDelivery.updateMany({
    where: {
      marketId: record.market.marketId,
      eventId: delivery.eventId,
      subscriber: delivery.subscriber,
      status: 'pending',
    },
    data: {
      status: 'delivered',
      deliveredAt: new Date(record.now().epochMilliseconds),
      errorCode: null,
    },
  });
}
