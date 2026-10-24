import { Temporal } from '@mondapac-drive/shared-kernel';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { smsKindFor, webhookBody, type DeliveryChange } from './delivery-change';

const change = (overrides: Partial<DeliveryChange>): DeliveryChange => ({
  eventId: '0190a000-0000-7000-8000-000000000001',
  type: 'delivery.status-changed',
  occurredAt: Temporal.Instant.from('2026-11-02T00:00:00Z'),
  deliveryId: '0190a000-0000-7000-8000-000000000002',
  merchantId: 'm1',
  externalReference: 'ORD-1',
  status: 'ASSIGNED',
  ...overrides,
});

describe('what a delivery change sends', () => {
  it.each([
    [{ type: 'delivery.booked', status: 'DISPATCHING' }, 'booked'],
    [{ status: 'PICKED_UP' }, 'on_the_way'],
    [{ status: 'DELIVERED' }, 'delivered'],
    [{ status: 'DELIVERY_FAILED' }, 'failed'],
    [{ status: 'ASSIGNED' }, undefined],
    [{ status: 'AT_DROPOFF' }, undefined],
    [{ type: 'delivery.cancelled', status: 'CANCELLED' }, undefined],
  ] as const)('%o sends the SMS %s', (overrides, kind) => {
    expect(smsKindFor(change(overrides))).toBe(kind);
  });

  it.each(TEST_MARKET_IDS)('builds a body of ids and statuses only, in %s', (marketId) => {
    const body = webhookBody(marketId, change({ previousStatus: 'DISPATCHING' }));
    expect(body).toEqual({
      id: '0190a000-0000-7000-8000-000000000001',
      type: 'delivery.status-changed',
      occurredAt: '2026-11-02T00:00:00Z',
      marketId,
      data: {
        deliveryId: '0190a000-0000-7000-8000-000000000002',
        externalReference: 'ORD-1',
        status: 'ASSIGNED',
        previousStatus: 'DISPATCHING',
      },
    });
  });
});
