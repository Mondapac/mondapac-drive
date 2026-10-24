import { describe, expect, it } from 'vitest';
import {
  distanceMetres,
  exceptionOf,
  exceptionsOf,
  pinPoint,
  roundPoint,
  viewCircle,
  type MapDelivery,
} from './model.ts';

const delivery = (overrides: Partial<MapDelivery>): MapDelivery => ({
  id: '0190a000-0000-7000-8000-000000000001',
  reference: 'ORD-1',
  status: 'ASSIGNED',
  temperature: 'ambient',
  courierId: null,
  pickup: { lat: -27.47, lng: 153.02 },
  dropoff: { lat: -27.5, lng: 153.05 },
  exception: null,
  ...overrides,
});

describe('live map model', () => {
  it('flags the API exception first, then a failed delivery', () => {
    expect(exceptionOf('DISPATCHING', 'dispatch-exhausted')).toBe('dispatch-exhausted');
    expect(exceptionOf('PICKED_UP', 'cold-chain-breach')).toBe('cold-chain-breach');
    expect(exceptionOf('DELIVERY_FAILED', null)).toBe('failed');
    expect(exceptionOf('DELIVERY_FAILED', undefined)).toBe('failed');
    expect(exceptionOf('ASSIGNED', null)).toBeNull();
  });

  it('pins the pickup before collection and on a return, the drop-off while carried', () => {
    for (const status of ['DISPATCHING', 'ASSIGNED', 'AT_PICKUP', 'RETURNING'] as const) {
      expect(pinPoint(delivery({ status }))).toEqual({ lat: -27.47, lng: 153.02 });
    }
    for (const status of ['PICKED_UP', 'AT_DROPOFF', 'DELIVERY_FAILED'] as const) {
      expect(pinPoint(delivery({ status }))).toEqual({ lat: -27.5, lng: 153.05 });
    }
  });

  it('lists exceptions, cold chain first, then exhausted dispatch, then failed', () => {
    const list = exceptionsOf([
      delivery({ reference: 'B', exception: 'failed' }),
      delivery({ reference: 'A', exception: 'dispatch-exhausted' }),
      delivery({ reference: 'C' }),
      delivery({ reference: 'D', exception: 'cold-chain-breach' }),
      delivery({ reference: 'A2', exception: 'failed' }),
    ]);
    expect(list.map((row) => row.reference)).toEqual(['D', 'A', 'A2', 'B']);
  });

  it('measures distances in metres on the AU and ZZ sides of the globe alike', () => {
    // Brisbane CBD to South Bank, and two points in Tokyo: about 1 km each.
    expect(
      distanceMetres({ lat: -27.4698, lng: 153.0251 }, { lat: -27.4785, lng: 153.0203 }),
    ).toBeCloseTo(1076, -1);
    expect(
      distanceMetres({ lat: 35.6812, lng: 139.7671 }, { lat: 35.69, lng: 139.7671 }),
    ).toBeCloseTo(978, -1);
  });

  it('asks for the view circle with a rounded center, capped and at least 100 m', () => {
    const circle = viewCircle(
      { lat: 35.681234, lng: 139.767125 },
      { lat: 35.75, lng: 139.85 },
      20_000,
    );
    expect(circle.center).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(circle.radiusM).toBeGreaterThan(10_000);
    expect(viewCircle({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, 20_000).radiusM).toBe(20_000);
    expect(viewCircle({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }, 20_000).radiusM).toBe(100);
    expect(roundPoint({ lat: -27.46985, lng: 153.02514 })).toEqual({
      lat: -27.4698,
      lng: 153.0251,
    });
  });
});
