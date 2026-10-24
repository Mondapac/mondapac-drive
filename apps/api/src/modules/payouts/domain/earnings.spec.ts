import { Temporal } from '@mondapac-drive/shared-kernel';
import { AU, payoutMarkets, ZZ } from '../../../../test/support/payouts-markets';
import { earningFor, paidWaitingMinutes, type CompletedDelivery } from './earnings';
import { PayoutsDomainError } from './errors';

const at = (minutes: number) => Temporal.Instant.from('2026-11-02T00:00:00Z').add({ minutes });

function delivery(overrides: Partial<CompletedDelivery> = {}): CompletedDelivery {
  return {
    deliveryId: 'delivery-1',
    courierId: 'courier-1',
    vehicle: 'car',
    distanceMetres: 4200,
    temperature: 'chilled',
    arrivedAtPickup: at(0),
    pickedUpAt: at(12),
    arrivedAtDropoff: at(30),
    deliveredAt: at(33),
    ...overrides,
  };
}

describe('earningFor', () => {
  const au = payoutMarkets.get(AU);
  const zz = payoutMarkets.get(ZZ);

  it('pays a contractor the base, the distance, the cold-chain bonus and paid waiting (AU)', () => {
    const earning = earningFor(au, 'contractor', delivery());

    // car: 750 + 110/km x 4.2 km = 462; chilled 150; 12 min at pickup - 5 free = 7 x 30 = 210;
    // 3 min at drop-off is inside the free minutes.
    expect(earning.base).toEqual({ amount: 750n, currency: 'AUD' });
    expect(earning.distance).toEqual({ amount: 462n, currency: 'AUD' });
    expect(earning.coldChain).toEqual({ amount: 150n, currency: 'AUD' });
    expect(earning.paidWaitingMinutes).toBe(7);
    expect(earning.waiting).toEqual({ amount: 210n, currency: 'AUD' });
    expect(earning.total).toEqual({ amount: 1572n, currency: 'AUD' });
  });

  it('pays in whole yen in a currency with no minor unit (ZZ)', () => {
    const earning = earningFor(
      zz,
      'contractor',
      delivery({
        vehicle: 'motorbike',
        distanceMetres: 3500,
        temperature: 'ambient',
        pickedUpAt: at(10),
        arrivedAtDropoff: at(25),
        deliveredAt: at(30),
      }),
    );

    // motorbike: 400 + 80/km x 3.5 km = 280; no bonus; (10 - 3) + (5 - 3) = 9 min x 20 = 180.
    expect(earning.total).toEqual({ amount: 860n, currency: 'JPY' });
    expect(earning.paidWaitingMinutes).toBe(9);
  });

  it('rounds the distance pay half-up', () => {
    const bicycle = (distanceMetres: number) =>
      earningFor(au, 'contractor', delivery({ vehicle: 'bicycle', distanceMetres })).distance;

    expect(bicycle(1005).amount).toBe(90n); // 90.45
    expect(bicycle(1006).amount).toBe(91n); // 90.54
    expect(bicycle(0).amount).toBe(0n);
  });

  it('pays an employee nothing per delivery, but still counts the waiting', () => {
    for (const settings of [au, zz]) {
      const earning = earningFor(settings, 'employee', delivery({ vehicle: 'van' }));

      expect(earning.total).toEqual({ amount: 0n, currency: settings.currency });
      expect(earning.paidWaitingMinutes).toBeGreaterThan(0);
    }
  });

  it('refuses a vehicle the Market has no courier rate for', () => {
    expect(() => earningFor(zz, 'contractor', delivery({ vehicle: 'car' }))).toThrow(
      expect.objectContaining({ code: 'earnings.vehicle-not-rated' }) as unknown,
    );
  });

  it('refuses a distance that is not a whole number of metres', () => {
    for (const distanceMetres of [-1, 1.5, Number.NaN]) {
      expect(() => earningFor(au, 'contractor', delivery({ distanceMetres }))).toThrow(
        PayoutsDomainError,
      );
    }
  });
});

describe('paidWaitingMinutes', () => {
  const au = payoutMarkets.get(AU);
  const zz = payoutMarkets.get(ZZ);

  it("caps the paid minutes at the Market's maximum", () => {
    const long = delivery({ pickedUpAt: at(60), arrivedAtDropoff: at(70), deliveredAt: at(90) });

    expect(paidWaitingMinutes(au, long)).toBe(30);
    expect(paidWaitingMinutes(zz, long)).toBe(20);
  });

  it('counts whole minutes only, and nothing at a stop whose times are unknown', () => {
    const partial = delivery({
      pickedUpAt: at(0).add({ minutes: 5, seconds: 59 }),
      arrivedAtDropoff: undefined,
    });

    expect(paidWaitingMinutes(au, partial)).toBe(0);
    expect(paidWaitingMinutes(zz, partial)).toBe(2);
  });

  it('refuses a courier who left a stop before arriving', () => {
    expect(() => paidWaitingMinutes(au, delivery({ pickedUpAt: at(-1) }))).toThrow(
      expect.objectContaining({ code: 'earnings.invalid-timeline' }) as unknown,
    );
  });
});
