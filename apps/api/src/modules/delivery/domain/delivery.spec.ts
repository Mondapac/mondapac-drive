import { geoPoint, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { AU, markets, ZZ } from '../../../../test/support/delivery-markets';
import {
  applyDeliveryEvent,
  createDelivery,
  type DeliveryState,
  type NewDelivery,
} from './delivery';
import { parcel, type Temperature } from './parcel';
import { priceDelivery } from './pricing';

const at = Temporal.Instant.from('2026-11-02T00:00:00Z');
const stop = {
  address: '1 Example St',
  postcode: '4000',
  point: geoPoint(-27.47, 153.02),
  contactName: 'Sam',
  contactPhone: '+61 400 000 000',
};

function newDelivery(
  temperature: Temperature,
  overrides: Partial<NewDelivery> = {},
): DeliveryState {
  const p = parcel(5000, 20, temperature);
  return createDelivery({
    id: '0190a000-0000-7000-8000-000000000001' as Id<'Delivery'>,
    marketId: AU,
    merchantId: 'm1',
    externalReference: 'order-1',
    serviceAreaCode: 'greater-brisbane',
    pickup: stop,
    dropoff: stop,
    parcel: p,
    mode: 'on_demand',
    quote: priceDelivery(markets.get(AU), { parcel: p, distanceMetres: 3000, mode: 'on_demand' }),
    createdAt: at,
    ...overrides,
  });
}

function run(
  delivery: DeliveryState,
  ...events: Parameters<typeof applyDeliveryEvent>[1][]
): DeliveryState {
  return events.reduce((d, e) => applyDeliveryEvent(d, e, at, markets.get(d.marketId)), delivery);
}

const toDropoff = [
  { type: 'courier_assigned', courierId: 'c1', vehicle: 'bicycle' },
  { type: 'arrived_at_pickup' },
  { type: 'picked_up' },
  { type: 'arrived_at_dropoff' },
] as const;

describe('delivery lifecycle', () => {
  it('starts on-demand deliveries in dispatch and scheduled ones in waiting', () => {
    expect(newDelivery('ambient').status).toBe('DISPATCHING');
    const scheduled = newDelivery('ambient', {
      mode: 'scheduled',
      window: {
        start: Temporal.Instant.from('2026-11-02T03:00:00Z'),
        end: Temporal.Instant.from('2026-11-02T04:00:00Z'),
      },
    });
    expect(scheduled.status).toBe('SCHEDULED');
    expect(run(scheduled, { type: 'dispatch_opened' }).status).toBe('DISPATCHING');
  });

  it('walks the happy path and keeps a history', () => {
    const done = run(newDelivery('ambient'), ...toDropoff, {
      type: 'delivered',
      proof: { kind: 'pin' },
    });
    expect(done.status).toBe('DELIVERED');
    expect(done.courierId).toBe('c1');
    expect(done.history.map((h) => h.status)).toEqual([
      'DISPATCHING',
      'ASSIGNED',
      'AT_PICKUP',
      'PICKED_UP',
      'AT_DROPOFF',
      'DELIVERED',
    ]);
    expect(done.version).toBe(6);
  });

  it('rejects events out of order', () => {
    expect(() => run(newDelivery('ambient'), { type: 'picked_up' })).toThrow(
      expect.objectContaining({ code: 'delivery.invalid-transition' }) as Error,
    );
  });

  it('needs proof of delivery', () => {
    expect(() => run(newDelivery('ambient'), ...toDropoff, { type: 'delivered' })).toThrow(
      expect.objectContaining({ code: 'delivery.proof-required' }) as Error,
    );
  });

  it('cannot cancel once the parcel is picked up, and needs a reason', () => {
    expect(() => run(newDelivery('ambient'), { type: 'cancelled' })).toThrow(
      expect.objectContaining({ code: 'delivery.reason-required' }) as Error,
    );
    expect(() =>
      run(newDelivery('ambient'), ...toDropoff.slice(0, 3), {
        type: 'cancelled',
        reason: 'merchant',
      }),
    ).toThrow(expect.objectContaining({ code: 'delivery.invalid-transition' }) as Error);
    expect(() => run(newDelivery('ambient'), { type: 'cancelled', reason: 'refunded' })).toThrow(
      expect.objectContaining({ code: 'delivery.reason-required' }) as Error,
    );
  });

  it('returns a failed delivery to the sender', () => {
    const returned = run(
      newDelivery('ambient'),
      ...toDropoff,
      { type: 'delivery_failed', reason: 'nobody home' },
      { type: 'return_started' },
      { type: 'returned' },
    );
    expect(returned.status).toBe('RETURNED');
  });

  it('puts a delivery back in dispatch when the courier drops it', () => {
    const back = run(newDelivery('ambient'), toDropoff[0], { type: 'courier_unassigned' });
    expect(back.status).toBe('DISPATCHING');
    expect(back.courierId).toBeUndefined();
  });
});

describe('cold chain', () => {
  const chilledToPickup = toDropoff.slice(0, 2);

  it('requires a reading at pickup and at drop-off', () => {
    expect(() => run(newDelivery('chilled'), ...chilledToPickup, { type: 'picked_up' })).toThrow(
      expect.objectContaining({ code: 'cold-chain.reading-required' }) as Error,
    );
  });

  it('refuses a reading above the Market’s limit', () => {
    expect(() =>
      run(newDelivery('chilled'), ...chilledToPickup, { type: 'picked_up', temperatureCelsius: 7 }),
    ).toThrow(expect.objectContaining({ code: 'cold-chain.breach' }) as Error);
  });

  it('accepts readings within the limit', () => {
    const done = run(
      newDelivery('chilled'),
      ...chilledToPickup,
      { type: 'picked_up', temperatureCelsius: 3 },
      { type: 'arrived_at_dropoff' },
      { type: 'delivered', temperatureCelsius: 4, proof: { kind: 'photo', photoRef: 'p/1.jpg' } },
    );
    expect(done.status).toBe('DELIVERED');
  });

  it('uses each Market’s own limits', () => {
    const zz = newDelivery('chilled', { marketId: ZZ });
    // 4.5°C passes the AU limit of 5°C but not ZZ's 4°C.
    expect(() =>
      run(zz, ...chilledToPickup, { type: 'picked_up', temperatureCelsius: 4.5 }),
    ).toThrow(expect.objectContaining({ code: 'cold-chain.breach' }) as Error);
  });
});
