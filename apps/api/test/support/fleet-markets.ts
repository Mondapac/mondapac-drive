import { Temporal, uuidV7, type Id, type MarketId } from '@mondapac-drive/shared-kernel';
import { ConfigFleetRulesProvider } from '../../src/modules/fleet/infrastructure/config-fleet-rules.provider';
import {
  addVehicle,
  registerCourier,
  submitDocument,
  verifyDocument,
  type CourierState,
} from '../../src/modules/fleet/domain/courier';
import type { EmploymentType } from '../../src/modules/fleet/domain/courier-status';
import { requirementApplies } from '../../src/modules/fleet/domain/documents';
import type { MarketFleetRules } from '../../src/modules/fleet/domain/fleet-rules';
import type { NewVehicle } from '../../src/modules/fleet/domain/vehicle';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { loadServiceAreas } from '../../src/platform/market-config/service-area-config';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from './test-config';

/** The fleet rules of the real AU file and the synthetic ZZ market (other documents). */
export const fleetRules = new ConfigFleetRulesProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
  loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS),
);

/** A service area of each fixture Market. */
export const TEST_SERVICE_AREAS: Readonly<Record<string, string>> = {
  AU: 'greater-brisbane',
  ZZ: 'zz-central',
};

export const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
/** A year after T0: the expiry the helpers give a document that expires. */
export const IN_A_YEAR = T0.add({ hours: 24 * 365 });

const PROCESS_BITS = crypto.getRandomValues(new Uint8Array(4));
let sequence = 0;
/**
 * A valid UUIDv7 of T0: random per process (spec files share a database), then a counter, so
 * the ids of one process rise in the order they are made, as the platform generator's do.
 */
export function nextId<K extends string>(): Id<K> {
  sequence += 1;
  const bytes = new Uint8Array(10);
  bytes.set(PROCESS_BITS);
  let rest = sequence;
  for (let index = bytes.length - 1; index >= 4; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return uuidV7(T0.epochMilliseconds, bytes) as Id<K>;
}

let plates = 0;

export interface CourierOptions {
  readonly marketId: MarketId;
  readonly employmentType?: EmploymentType;
  readonly coldChainCapable?: boolean;
  readonly serviceAreaCode?: string;
  readonly actorId?: string;
  readonly id?: Id<'Courier'>;
}

export function applicant(options: CourierOptions): CourierState {
  return registerCourier({
    id: options.id ?? nextId<'Courier'>(),
    marketId: options.marketId,
    actorId: options.actorId ?? `account-${nextId()}`,
    employmentType: options.employmentType ?? 'contractor',
    serviceAreaCode: options.serviceAreaCode ?? TEST_SERVICE_AREAS[options.marketId]!,
    coldChainCapable: options.coldChainCapable ?? true,
    createdAt: T0,
  });
}

export function vehicleInput(overrides: Partial<NewVehicle> = {}): NewVehicle {
  return {
    id: nextId<'Vehicle'>(),
    type: 'van',
    plate: `ABC${(plates++ % 1000).toString().padStart(3, '0')}`,
    maxWeightGrams: 400_000,
    maxVolumeLitres: 2000,
    coldBox: 'refrigerated',
    ...overrides,
  };
}

/**
 * Submits and verifies, at `at`, every document the Market requires of this courier for the
 * vehicle (the cold-chain ones too when `coldChain`), except the types in `skip`.
 */
export function withVerifiedDocuments(
  courier: CourierState,
  rules: MarketFleetRules,
  vehicleId: Id<'Vehicle'>,
  options: { coldChain?: boolean; skip?: readonly string[]; expiresAt?: Temporal.Instant } = {},
  at: Temporal.Instant = T0,
): CourierState {
  const vehicle = courier.vehicles.find((v) => v.id === vehicleId)!;
  let current = courier;
  for (const requirement of rules.documents) {
    if (options.skip?.includes(requirement.type)) continue;
    if (
      !requirementApplies(requirement, courier.employmentType, vehicle, options.coldChain ?? false)
    ) {
      continue;
    }
    const id = nextId<'CourierDocument'>();
    current = submitDocument(
      current,
      {
        id,
        type: requirement.type,
        ...(requirement.perVehicle ? { vehicleId } : {}),
        fileKey: `fleet/${courier.marketId}/${courier.id}/${id}`,
        mediaType: 'application/pdf',
        ...(requirement.expires ? { expiresAt: options.expiresAt ?? IN_A_YEAR } : {}),
      },
      rules,
      at,
    ).courier;
    current = verifyDocument(current, id, at).courier;
  }
  return current;
}

/** An applicant with one van whose documents (cold chain included) are all verified. */
export function eligibleApplicant(
  options: CourierOptions,
  vehicle: Partial<NewVehicle> = {},
): { courier: CourierState; vehicleId: Id<'Vehicle'> } {
  const rules = fleetRules.get(options.marketId);
  const input = vehicleInput(vehicle);
  const withVehicle = addVehicle(applicant(options), input).courier;
  return {
    courier: withVerifiedDocuments(withVehicle, rules, input.id, { coldChain: true }),
    vehicleId: input.id,
  };
}
