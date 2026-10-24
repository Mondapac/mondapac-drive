import { geoPoint, Temporal, uuidV7, type Id } from '@mondapac-drive/shared-kernel';
import { ConfigDispatchSettingsProvider } from '../../src/modules/dispatch/infrastructure/config-dispatch-settings.provider';
import type { OfferStops } from '../../src/modules/dispatch/domain/dispatch-job';
import type {
  AvailableCourier,
  DispatchRequirements,
} from '../../src/modules/dispatch/domain/matching';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, testMarketId } from './test-config';

/**
 * The dispatch settings of the real AU file (one courier at a time, 30 s, 5 rounds) and the
 * synthetic ZZ market (waves of 2, 20 s, 3 rounds).
 */
export const dispatchSettings = new ConfigDispatchSettingsProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);

export const AU = testMarketId('AU');
export const ZZ = testMarketId('ZZ');

/** A predictable courier id: UUIDv7 with `n` in the random bits. */
export function courierId(n: number): Id<'Courier'> {
  const bytes = new Uint8Array(10);
  bytes[9] = n;
  return uuidV7(1_800_000_000_000, bytes) as Id<'Courier'>;
}

/** A chilled 5 kg parcel priced for a motorbike, picked up in the given service area. */
export function requirements(overrides: Partial<DispatchRequirements> = {}): DispatchRequirements {
  return {
    serviceAreaCode: 'area-1',
    pickup: geoPoint(-27.47, 153.02),
    minimumVehicle: 'motorbike',
    weightGrams: 5000,
    volumeLitres: 20,
    temperature: 'chilled',
    ...overrides,
  };
}

/** What an offer shows: two street addresses and the trip distance. */
export function stops(overrides: Partial<OfferStops> = {}): OfferStops {
  return {
    pickupAddress: '1 Pickup Street',
    dropoffAddress: '2 Dropoff Road',
    dropoff: geoPoint(-27.5, 153.05),
    tripDistanceMetres: 4200,
    ...overrides,
  };
}

/** A free courier on a chilled-capable car, idle since `idleSince`. */
export function courier(
  n: number,
  overrides: Partial<AvailableCourier> = {},
  idleSince = Temporal.Instant.from('2026-11-02T00:00:00Z'),
): AvailableCourier {
  return {
    courierId: courierId(n),
    vehicle: {
      type: 'car',
      maxWeightGrams: 50_000,
      maxVolumeLitres: 300,
      temperatures: ['ambient', 'chilled', 'frozen'],
    },
    serviceAreaCodes: ['area-1'],
    idleSince,
    ...overrides,
  };
}
