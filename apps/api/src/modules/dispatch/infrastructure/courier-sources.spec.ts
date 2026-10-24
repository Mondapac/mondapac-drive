import { Temporal, type MarketId } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { AU, courierId, requirements, ZZ } from '../../../../test/support/dispatch-markets';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { FleetDirectory } from '../../fleet';
import type { CourierPositions } from '../../tracking';
import { FleetCourierAvailability } from './fleet-courier-availability';
import { TrackingCourierProximity } from './tracking-courier-proximity';

const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('the fleet and tracking courier sources in %s', (_name, marketId: MarketId) => {
  const context = testCallContext(testMarketContext(marketId, 'mondapac'), 'system');
  const offered = Object.keys(registry.get(marketId).delivery.rateCard.vehicles);

  const vehicle = (
    type: string,
    maxWeightGrams = 50_000,
    temperatures = ['ambient', 'chilled'],
  ) => ({
    vehicleId: `vehicle-${type}`,
    type,
    maxWeightGrams,
    maxVolumeLitres: 300,
    temperatures,
  });
  const idle = (minute: number) =>
    Temporal.Instant.from('2026-11-02T08:00:00Z').add({ minutes: minute });

  /**
   * A fleet where courier 1 holds a van, courier 2 a car and a van, courier 3 a motorbike too
   * small for 5 kg and a car, and courier 4 only that motorbike; one answer has a malformed id.
   */
  function fleet(asked: unknown[]) {
    return {
      findAvailableCouriers: (_c: unknown, query: unknown) => {
        asked.push(query);
        return Promise.resolve([
          {
            courierId: courierId(2),
            vehicles: [vehicle('car'), vehicle('van')],
            idleSince: idle(1),
          },
          { courierId: courierId(1), vehicles: [vehicle('van')], idleSince: idle(2) },
          {
            courierId: courierId(3),
            vehicles: [vehicle('motorbike', 1000), vehicle('car')],
            idleSince: idle(3),
          },
          { courierId: courierId(4), vehicles: [vehicle('motorbike', 1000)], idleSince: idle(4) },
          { courierId: 'not-an-id', vehicles: [vehicle('van')], idleSince: idle(5) },
        ]);
      },
    } as unknown as FleetDirectory;
  }

  it("asks fleet once for the Market's types from the delivery's vehicle up", async () => {
    const asked: unknown[] = [];
    await new FleetCourierAvailability(fleet(asked), registry).findEligibleCouriers(
      context,
      requirements({ minimumVehicle: 'motorbike', temperature: 'chilled' }),
    );

    const types = ['motorbike', 'car', 'van'].filter((t) => offered.includes(t));
    expect(asked).toEqual([{ vehicleTypes: types, coldChain: true, serviceArea: 'area-1' }]);
  });

  it("keeps each courier's smallest vehicle that carries the parcel, with fleet's account id and idle time", async () => {
    const found = await new FleetCourierAvailability(fleet([]), registry).findEligibleCouriers(
      context,
      requirements({ minimumVehicle: 'motorbike', temperature: 'chilled', weightGrams: 5000 }),
    );

    const byId = Object.fromEntries(found.map((c) => [c.courierId, c]));
    const carOrVan = offered.includes('car') ? 'car' : 'van';
    expect(Object.keys(byId).sort()).toEqual(
      [courierId(1), courierId(2), ...(offered.includes('car') ? [courierId(3)] : [])].sort(),
    );
    expect(byId[courierId(2)]?.vehicle.type).toBe(carOrVan);
    expect(byId[courierId(1)]?.vehicle).toEqual({
      type: 'van',
      maxWeightGrams: 50_000,
      maxVolumeLitres: 300,
      temperatures: ['ambient', 'chilled'],
    });
    expect(byId[courierId(1)]?.idleSince).toEqual(idle(2));
    expect(found.every((c) => c.serviceAreaCodes.includes('area-1'))).toBe(true);
  });

  it('asks tracking for the service area and drops a position without a courier id', async () => {
    const calls: unknown[] = [];
    const positions = {
      nearest: (...args: unknown[]) => {
        calls.push(args.slice(1));
        return Promise.resolve([
          { position: { courierId: courierId(1) }, distanceMetres: 120 },
          { position: { courierId: 'not-an-id' }, distanceMetres: 50 },
        ]);
      },
    } as unknown as CourierPositions;

    const found = await new TrackingCourierProximity(positions).nearestCouriers(
      context,
      requirements().pickup,
      { radiusMetres: 5000, limit: 10, serviceArea: 'area-1' },
    );

    expect(calls).toEqual([
      [
        {
          point: requirements().pickup,
          radiusMetres: 5000,
          limit: 10,
          serviceArea: 'area-1',
        },
      ],
    ]);
    expect(found).toEqual([{ courierId: courierId(1), distanceMetres: 120 }]);
  });
});
