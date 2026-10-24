import { ok, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type {
  DeliveryEventInput,
  RecordDeliveryChange,
} from '../../application/use-cases/record-delivery-change.use-case';
import { apiStatus, deliveryChangeSubscriptions } from './delivery-change.subscriptions';

const deliveryId = '0195f000-0000-7000-8000-000000000001';
const eventId = '0195f000-0000-7000-8000-0000000000e1' as Id;
const occurredAt = Temporal.Instant.from('2026-11-02T00:00:00Z');

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    eventId,
    type,
    occurredAt,
    payload,
  } as never;
}

describe.each(TEST_MARKET_IDS)('delivery subscriptions of notifications in %s', (marketId) => {
  const context = testCallContext(
    testMarketContext(marketId, 'default'),
    'system',
  ) as SubscriberContext;
  const delivery = { eventId, subscriber: 'x', attempt: 1 } as unknown as EventDelivery;

  function wired(answer: 'ok' | 'refuse' = 'ok') {
    const seen: DeliveryEventInput[] = [];
    const record = {
      execute: (_context: unknown, input: DeliveryEventInput) => {
        seen.push(input);
        return Promise.resolve(
          answer === 'ok'
            ? ok({ handled: true, webhookCalls: 0, sms: false })
            : { ok: false, error: { code: 'notifications.delivery-unknown' } },
        );
      },
    } as unknown as RecordDeliveryChange;
    const byName = new Map(deliveryChangeSubscriptions(record).map((entry) => [entry.name, entry]));
    return { seen, byName };
  }

  it('names statuses as the delivery API does', () => {
    expect(apiStatus('picked-up')).toBe('PICKED_UP');
    expect(apiStatus('delivery-failed')).toBe('DELIVERY_FAILED');
    expect(apiStatus('delivered')).toBe('DELIVERED');
  });

  it('maps each event to one change, with ids and codes only', async () => {
    const { seen, byName } = wired();
    await byName
      .get('notifications.delivery-booked')!
      .handle(
        envelope('delivery.booked.v1', { deliveryId, status: 'scheduled' }),
        delivery,
        context,
      );
    await byName.get('notifications.delivery-status-changed')!.handle(
      envelope('delivery.status-changed.v1', {
        deliveryId,
        status: 'delivery-failed',
        previousStatus: 'at-dropoff',
        courierId: null,
        reason: 'delivery-failed',
      }),
      delivery,
      context,
    );
    await byName.get('notifications.delivery-status-changed')!.handle(
      envelope('delivery.status-changed.v1', {
        deliveryId,
        status: 'picked-up',
        previousStatus: 'at-pickup',
        courierId: null,
        reason: null,
      }),
      delivery,
      context,
    );
    await byName.get('notifications.delivery-cancelled')!.handle(
      envelope('delivery.cancelled.v1', {
        deliveryId,
        previousStatus: 'assigned',
        reason: 'merchant-cancelled',
      }),
      delivery,
      context,
    );
    const common = { delivery, eventId, occurredAt, deliveryId };
    expect(seen).toEqual([
      { ...common, type: 'delivery.booked', status: 'SCHEDULED' },
      {
        ...common,
        type: 'delivery.status-changed',
        status: 'DELIVERY_FAILED',
        previousStatus: 'AT_DROPOFF',
        reason: 'delivery-failed',
      },
      {
        ...common,
        type: 'delivery.status-changed',
        status: 'PICKED_UP',
        previousStatus: 'AT_PICKUP',
      },
      {
        ...common,
        type: 'delivery.cancelled',
        status: 'CANCELLED',
        previousStatus: 'ASSIGNED',
        reason: 'merchant-cancelled',
      },
    ]);
  });

  it('throws on a refusal, so the delivery is retried', async () => {
    const { byName } = wired('refuse');
    await expect(
      byName
        .get('notifications.delivery-booked')!
        .handle(
          envelope('delivery.booked.v1', { deliveryId, status: 'dispatching' }),
          delivery,
          context,
        ),
    ).rejects.toThrow(/notifications.delivery-unknown/);
  });
});
