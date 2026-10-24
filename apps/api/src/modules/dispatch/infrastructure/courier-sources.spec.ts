import type { MarketId } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { AU, courierId, requirements, ZZ } from '../../../../test/support/dispatch-markets';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { FleetDirectory } from '../../fleet';
import type { CourierPositions } from '../../tracking/contracts/courier-positions.contract';
import { FleetCourierAvailability } from './fleet-courier-availability';
import { TrackingCourierProximity } from './tracking-courier-proximity';

const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('the fleet and tracking courier sources in %s', (_name, marketId: MarketId) => {
  const context = testCallContext(testMarketContext(marketId, 'mondapac'), 'system');
  const offered = Object.keys(registry.get(marketId).delivery.rateCard.vehicles);

  /** A fleet where courier 1 holds a van, courier 2 a car and a van, courier 3 a motorbike. */
  function fleet(asked: unknown[]) {
    const byType: Record<string, number[]> = { motorbike: [3], car: [2], van: [1, 2] };
    return {
      findEligibleCouriers: (_c: unknown, query: { vehicleTypes: string[] }) => {
        asked.push(query);
        return Promise.resolve(query.vehicleTypes.flatMap((t) => (byType[t] ?? []).map(courierId)));
      },
    } as unknown as FleetDirectory;
  }

  it("asks fleet type by type from the delivery's vehicle up, and keeps each courier's smallest", async () => {
    const asked: unknown[] = [];
    const found = await new FleetCourierAvailability(fleet(asked), registry).findEligibleCouriers(
      context,
      requirements({ minimumVehicle: 'motorbike', temperature: 'chilled' }),
    );

    const types = ['motorbike', 'car', 'van'].filter((t) => offered.includes(t));
    expect(asked).toEqual(
      types.map((t) => ({ vehicleTypes: [t], coldChain: true, serviceArea: 'area-1' })),
    );
    const vehicleOf = Object.fromEntries(found.map((c) => [c.courierId, c.vehicle.type]));
    expect(vehicleOf[courierId(3)]).toBe('motorbike');
    expect(vehicleOf[courierId(2)]).toBe(offered.includes('car') ? 'car' : 'van');
    expect(vehicleOf[courierId(1)]).toBe('van');
    expect(found.every((c) => c.vehicle.temperatures.includes('chilled'))).toBe(true);
  });

  it('takes the capacity of a type from the rate card of the Market', async () => {
    const found = await new FleetCourierAvailability(fleet([]), registry).findEligibleCouriers(
      context,
      requirements({ minimumVehicle: 'van', temperature: 'ambient' }),
    );
    const van = registry.get(marketId).delivery.rateCard.vehicles.van!;

    expect(found.map((c) => c.vehicle)).toEqual([
      {
        type: 'van',
        maxWeightGrams: van.maxWeightGrams,
        maxVolumeLitres: van.maxVolumeLitres,
        temperatures: ['ambient'],
      },
      {
        type: 'van',
        maxWeightGrams: van.maxWeightGrams,
        maxVolumeLitres: van.maxVolumeLitres,
        temperatures: ['ambient'],
      },
    ]);
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
