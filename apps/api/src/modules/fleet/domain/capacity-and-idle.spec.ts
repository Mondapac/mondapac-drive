import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  applicant,
  asDeclared,
  eligibleApplicant,
  fleetRules,
  T0,
  TEST_SERVICE_AREAS,
  vehicleInput,
  withVerifiedDocuments,
} from '../../../../test/support/fleet-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  addVehicle,
  approveCourier,
  changeShift,
  offboardCourier,
  setTaxRegistration,
  setVehicleCapacity,
  type CourierState,
} from './courier';
import { holdsValidDocument } from './documents';
import { vehiclesForWork, type DispatchNeed } from './eligibility';
import { FleetDomainError } from './errors';
import { VEHICLE_TYPES } from './vehicle';
import { capacityFor, vehicleTemperatures } from './vehicle-class';

const code = (work: () => unknown): string | undefined => {
  try {
    work();
    return undefined;
  } catch (error) {
    if (error instanceof FleetDomainError) return error.code;
    throw error;
  }
};

describe.each(TEST_MARKET_IDS)('vehicle capacity, idle time and payee facts in %s', (marketId) => {
  const rules = fleetRules.get(marketId);
  const area = TEST_SERVICE_AREAS[marketId]!;
  const offered = VEHICLE_TYPES.filter((type) => rules.vehicleClasses[type] !== undefined);
  const notOffered = VEHICLE_TYPES.filter((type) => rules.vehicleClasses[type] === undefined);
  const later = (minutes: number) => T0.add({ minutes });

  const active = (courier: CourierState) =>
    approveCourier(courier, asDeclared(courier), rules, T0).courier;

  it('takes the vehicle classes from the rate card, which offers the van in every fixture', () => {
    expect(offered).toContain('van');
    expect(rules.vehicleClasses.van).toMatchObject({
      maxWeightGrams: expect.any(Number) as number,
      maxVolumeLitres: expect.any(Number) as number,
    });
  });

  it('gives a new vehicle the rate card capacity of its type unless one is given', () => {
    const van = rules.vehicleClasses.van!;
    expect(capacityFor('van', {}, rules)).toEqual({
      maxWeightGrams: van.maxWeightGrams,
      maxVolumeLitres: van.maxVolumeLitres,
    });
    expect(capacityFor('van', { maxWeightGrams: 123 }, rules)).toEqual({
      maxWeightGrams: 123,
      maxVolumeLitres: van.maxVolumeLitres,
    });
    for (const type of notOffered) {
      expect(code(() => capacityFor(type, {}, rules))).toBe('fleet.vehicle.type-not-offered');
    }
  });

  it('lets an operator override an active vehicle’s capacity, within range', () => {
    const { courier, vehicleId } = eligibleApplicant({ marketId });
    const changed = setVehicleCapacity(courier, vehicleId, {
      maxWeightGrams: 250_000,
      maxVolumeLitres: 1500,
    }).courier;
    expect(changed.version).toBe(courier.version + 1);
    expect(changed.vehicles.find((v) => v.id === vehicleId)).toMatchObject({
      maxWeightGrams: 250_000,
      maxVolumeLitres: 1500,
    });
    const same = setVehicleCapacity(changed, vehicleId, {
      maxWeightGrams: 250_000,
      maxVolumeLitres: 1500,
    });
    expect(same.courier).toBe(changed);
    expect(
      code(() => setVehicleCapacity(courier, vehicleId, { maxWeightGrams: 0, maxVolumeLitres: 1 })),
    ).toBe('fleet.vehicle.capacity-invalid');
    expect(
      code(() =>
        setVehicleCapacity(courier, vehicleId, { maxWeightGrams: 1.5, maxVolumeLitres: 1 }),
      ),
    ).toBe('fleet.vehicle.capacity-invalid');
  });

  it('lets a vehicle carry what its box keeps and the Market lets its type carry', () => {
    for (const type of offered) {
      const allowed = rules.vehicleClasses[type]!.temperatures;
      for (const coldBox of ['none', 'insulated', 'refrigerated'] as const) {
        const vehicle = { ...vehicleInput({ type, coldBox }), active: true };
        const carried = vehicleTemperatures(vehicle, rules);
        expect(carried.every((t) => allowed.includes(t))).toBe(true);
        if (coldBox === 'none') expect(carried).toEqual(['ambient']);
        if (coldBox === 'refrigerated') expect(carried).toEqual(allowed);
      }
    }
  });

  it('starts the idle time going online from offline or a delivery, and keeps it over a pause', () => {
    const { courier } = eligibleApplicant({ marketId });
    const working = active(courier);
    expect(working.idleSince).toBeUndefined();

    const online = changeShift(working, 'online', rules, later(1)).courier;
    expect(online.idleSince).toEqual(later(1));
    const paused = changeShift(online, 'paused', rules, later(2)).courier;
    const back = changeShift(paused, 'online', rules, later(3)).courier;
    expect(back.idleSince).toEqual(later(1));
    const carrying = changeShift(back, 'on_delivery', rules, later(4)).courier;
    expect(carrying.idleSince).toEqual(later(1));
    const done = changeShift(carrying, 'online', rules, later(5)).courier;
    expect(done.idleSince).toEqual(later(5));
    const off = changeShift(done, 'offline', rules, later(6)).courier;
    expect(changeShift(off, 'online', rules, later(7)).courier.idleSince).toEqual(later(7));
  });

  describe('vehiclesForWork', () => {
    const need = (overrides: Partial<DispatchNeed> = {}): DispatchNeed => ({
      vehicleTypes: ['van'],
      coldChain: false,
      serviceAreaCode: area,
      ...overrides,
    });
    const onlineWith = (vehicle: Parameters<typeof vehicleInput>[0], coldChain: boolean) => {
      const input = vehicleInput(vehicle);
      const withVehicle = addVehicle(applicant({ marketId }), input).courier;
      const documented = withVerifiedDocuments(withVehicle, rules, input.id, { coldChain });
      return {
        courier: changeShift(active(documented), 'online', rules, T0).courier,
        vehicleId: input.id,
      };
    };

    it('lists the eligible vehicles of the asked types with their capacity and temperatures', () => {
      const { courier, vehicleId } = onlineWith({ coldBox: 'refrigerated' }, true);
      expect(vehiclesForWork(courier, need(), rules, T0)).toEqual([
        {
          vehicle: courier.vehicles.find((v) => v.id === vehicleId),
          temperatures: rules.vehicleClasses.van!.temperatures,
        },
      ]);
      expect(vehiclesForWork(courier, need({ vehicleTypes: ['car'] }), rules, T0)).toEqual([]);
    });

    it('cuts a vehicle to ambient while the cold-chain documents are missing', () => {
      const { courier } = onlineWith({ coldBox: 'refrigerated' }, false);
      const [only] = vehiclesForWork(courier, need(), rules, T0);
      expect(only?.temperatures).toEqual(['ambient']);
      expect(vehiclesForWork(courier, need({ coldChain: true }), rules, T0)).toEqual([]);
    });

    it('lists nothing for a courier who is not online', () => {
      const { courier } = eligibleApplicant({ marketId });
      expect(vehiclesForWork(active(courier), need(), rules, T0)).toEqual([]);
    });
  });

  it('records tax registration until the courier is offboarded', () => {
    const courier = applicant({ marketId });
    expect(courier.taxRegistered).toBe(false);
    const registered = setTaxRegistration(courier, true).courier;
    expect(registered).toMatchObject({ taxRegistered: true, version: courier.version + 1 });
    expect(setTaxRegistration(registered, true).courier).toBe(registered);
    const gone = offboardCourier(registered, T0).courier;
    expect(code(() => setTaxRegistration(gone, false))).toBe('fleet.courier.offboarded');
  });

  it('finds the business-id document only when verified and of the courier', () => {
    const type = rules.businessIdDocumentType!;
    expect(rules.documents.find((d) => d.type === type)?.perVehicle).toBe(false);
    const { courier } = eligibleApplicant({ marketId, employmentType: 'contractor' });
    expect(holdsValidDocument(courier.documents, type, T0)).toBe(true);
    expect(holdsValidDocument(applicant({ marketId }).documents, type, T0)).toBe(false);
    const submittedOnly = courier.documents.map((d) =>
      d.type === type ? { ...d, status: 'submitted' as const } : d,
    );
    expect(holdsValidDocument(submittedOnly, type, T0)).toBe(false);
    expect(
      holdsValidDocument(courier.documents, type, Temporal.Instant.from('2100-01-01T00:00:00Z')),
    ).toBe(courier.documents.find((d) => d.type === type)?.expiresAt === undefined);
  });
});
