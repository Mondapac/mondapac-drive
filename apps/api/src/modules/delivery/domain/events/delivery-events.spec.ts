import { geoPoint, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { AU, markets, ZZ } from '../../../../../test/support/delivery-markets';
import { applyDeliveryEvent, createDelivery, type DeliveryEventInput } from '../delivery';
import { DELIVERY_STATUSES } from '../delivery-status';
import { parcel } from '../parcel';
import { priceDelivery } from '../pricing';
import { bookedEvent, changeEvents, statusCode } from './delivery-events';

const at = Temporal.Instant.from('2026-11-02T00:00:00Z');
const later = Temporal.Instant.from('2026-11-02T00:05:00Z');
const MERCHANT = '0190a000-0000-7000-8000-0000000000aa';
const COURIER = '0190a000-0000-7000-8000-0000000000c1';
const OTHER = '0190a000-0000-7000-8000-0000000000c2';

describe.each([AU, ZZ])('delivery events in market %s', (marketId) => {
  const settings = markets.get(marketId);
  const stop = {
    address: '1 Example St',
    postcode: marketId === AU ? '4000' : '1000',
    point: geoPoint(-27.47, 153.02),
    contactName: 'Sam',
    contactPhone: '+61 400 000 000',
  };

  function booked(mode: 'on_demand' | 'scheduled' = 'on_demand') {
    const p = parcel(5000, 20, 'ambient');
    return createDelivery({
      id: '0190a000-0000-7000-8000-000000000001' as Id<'Delivery'>,
      marketId,
      merchantId: MERCHANT,
      externalReference: 'order-1',
      serviceAreaCode: 'area',
      pickup: stop,
      dropoff: stop,
      parcel: p,
      mode,
      ...(mode === 'scheduled'
        ? { window: { start: at.add({ hours: 2 }), end: at.add({ hours: 3 }) } }
        : {}),
      quote: priceDelivery(settings, { parcel: p, distanceMetres: 3000, mode }),
      createdAt: at,
    });
  }

  const step = (events: DeliveryEventInput[], from = booked()) =>
    events.reduce((state, event) => applyDeliveryEvent(state, event, later, settings), from);

  it('books with ids and codes only, no stop or reference', () => {
    const scheduled = booked('scheduled');
    const event = bookedEvent(scheduled);
    expect(event).toMatchObject({
      type: 'delivery.booked.v1',
      aggregateType: 'delivery',
      aggregateVersion: 1,
      occurredAt: at,
      payload: {
        deliveryId: scheduled.id,
        merchantId: MERCHANT,
        status: 'scheduled',
        temperature: 'ambient',
        windowStart: at.add({ hours: 2 }),
        windowEnd: at.add({ hours: 3 }),
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/Example|Sam|\+61|order-1/);
  });

  it('writes one event per version, with the courier after each step', () => {
    const before = booked();
    const after = step(
      [
        { type: 'courier_assigned', courierId: COURIER, vehicle: 'car' },
        { type: 'courier_unassigned', reasonCode: 'courier-reassigned' },
        { type: 'courier_assigned', courierId: OTHER, vehicle: 'car' },
        { type: 'arrived_at_pickup' },
      ],
      before,
    );
    expect(
      changeEvents(before, after).map((event) => [event.aggregateVersion, event.payload]),
    ).toEqual([
      [
        2,
        {
          deliveryId: before.id,
          status: 'assigned',
          previousStatus: 'dispatching',
          courierId: COURIER,
          reason: null,
        },
      ],
      [
        3,
        {
          deliveryId: before.id,
          status: 'dispatching',
          previousStatus: 'assigned',
          courierId: null,
          reason: 'courier-reassigned',
        },
      ],
      [
        4,
        {
          deliveryId: before.id,
          status: 'assigned',
          previousStatus: 'dispatching',
          courierId: OTHER,
          reason: null,
        },
      ],
      [
        5,
        {
          deliveryId: before.id,
          status: 'at-pickup',
          previousStatus: 'assigned',
          courierId: OTHER,
          reason: null,
        },
      ],
    ]);
  });

  it('codes a failure, an unassignment by default as the dispatcher’s, and a cancel', () => {
    const assigned = step([{ type: 'courier_assigned', courierId: COURIER, vehicle: 'car' }]);
    const dropped = step([{ type: 'courier_unassigned' }], assigned);
    expect(changeEvents(assigned, dropped)[0]!.payload).toMatchObject({
      reason: 'dispatcher-unassigned',
    });

    const failing = step([{ type: 'arrived_at_pickup' }, { type: 'picked_up' }], assigned);
    const failed = step([{ type: 'delivery_failed', reason: 'nobody home' }], failing);
    expect(changeEvents(failing, failed)[0]!.payload).toMatchObject({
      status: 'delivery-failed',
      reason: 'delivery-failed',
    });

    const cancelled = step(
      [{ type: 'cancelled', reason: 'refunded', reasonCode: 'operator-cancelled' }],
      assigned,
    );
    expect(changeEvents(assigned, cancelled)).toEqual([
      expect.objectContaining({
        type: 'delivery.cancelled.v1',
        aggregateVersion: 3,
        payload: {
          deliveryId: assigned.id,
          previousStatus: 'assigned',
          reason: 'operator-cancelled',
        },
      }),
    ]);
    expect(JSON.stringify(changeEvents(failing, failed))).not.toContain('nobody home');
  });

  it('clears the exception flag on assignment and cancel only', () => {
    const flagged = { ...booked(), exception: 'dispatch-exhausted' as const };
    expect(
      step([{ type: 'courier_assigned', courierId: COURIER, vehicle: 'car' }], flagged),
    ).not.toHaveProperty('exception');
    expect(
      step([{ type: 'cancelled', reason: 'x', reasonCode: 'merchant-cancelled' }], flagged),
    ).not.toHaveProperty('exception');
  });
});

it('maps every status to a lower-case code', () => {
  expect(DELIVERY_STATUSES.map(statusCode)).toContain('at-pickup');
  expect(new Set(DELIVERY_STATUSES.map(statusCode)).size).toBe(DELIVERY_STATUSES.length);
});
