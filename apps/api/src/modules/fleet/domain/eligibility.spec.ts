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
import { addVehicle, approveCourier, changeShift, type CourierState } from './courier';
import { canTakeWork, eligibleVehicleTypes, type DispatchNeed } from './eligibility';

describe.each(TEST_MARKET_IDS)('eligibility in market %s', (marketId) => {
  const rules = fleetRules.get(marketId);
  const area = TEST_SERVICE_AREAS[marketId]!;
  const contractorOnly = rules.documents.filter((d) => d.employmentTypes?.includes('contractor'));
  const coldChainOnly = rules.documents.filter((d) => d.coldChainOnly);

  function online(courier: CourierState): CourierState {
    const active = approveCourier(courier, asDeclared(courier), rules, T0).courier;
    return changeShift(active, 'online', rules, T0).courier;
  }

  const need = (overrides: Partial<DispatchNeed> = {}): DispatchNeed => ({
    vehicleTypes: ['van'],
    coldChain: false,
    serviceAreaCode: area,
    ...overrides,
  });

  it('the Market file has contractor-only and cold-chain-only documents', () => {
    expect(contractorOnly.length).toBeGreaterThan(0);
    expect(coldChainOnly.length).toBeGreaterThan(0);
  });

  it('asks a contractor for the contractor documents, and an employee not', () => {
    const skip = contractorOnly.map((d) => d.type);
    for (const employmentType of ['employee', 'contractor'] as const) {
      const van = vehicleInput();
      const courier = withVerifiedDocuments(
        addVehicle(applicant({ marketId, employmentType }), van).courier,
        rules,
        van.id,
        { skip },
      );
      expect(eligibleVehicleTypes(courier, rules, T0, false)).toEqual(
        employmentType === 'employee' ? ['van'] : [],
      );
    }
  });

  it('needs every applying document verified: a submitted one does not count', () => {
    const van = vehicleInput();
    const withVan = addVehicle(applicant({ marketId }), van).courier;
    const required = rules.documents.find((d) => !d.coldChainOnly && !d.employmentTypes)!;
    const missingOne = withVerifiedDocuments(withVan, rules, van.id, { skip: [required.type] });

    expect(eligibleVehicleTypes(missingOne, rules, T0, false)).toEqual([]);
  });

  it('takes cold chain only from a capable courier with a cold box and the cold-chain documents', () => {
    const { courier } = eligibleApplicant({ marketId });
    expect(eligibleVehicleTypes(courier, rules, T0, true)).toEqual(['van']);

    const notCapable = eligibleApplicant({ marketId, coldChainCapable: false }).courier;
    expect(eligibleVehicleTypes(notCapable, rules, T0, true)).toEqual([]);
    expect(eligibleVehicleTypes(notCapable, rules, T0, false)).toEqual(['van']);

    const noBox = eligibleApplicant({ marketId }, { coldBox: 'none' }).courier;
    expect(eligibleVehicleTypes(noBox, rules, T0, true)).toEqual([]);

    const van = vehicleInput();
    const noColdDocs = withVerifiedDocuments(
      addVehicle(applicant({ marketId }), van).courier,
      rules,
      van.id,
    );
    expect(eligibleVehicleTypes(noColdDocs, rules, T0, false)).toEqual(['van']);
    expect(eligibleVehicleTypes(noColdDocs, rules, T0, true)).toEqual([]);
  });

  it('counts only active vehicles', () => {
    const { courier } = eligibleApplicant({ marketId });
    const retired = {
      ...courier,
      vehicles: courier.vehicles.map((v) => ({ ...v, active: false })),
    };
    expect(eligibleVehicleTypes(retired, rules, T0, false)).toEqual([]);
  });

  describe('a dispatch need', () => {
    it('is met by an active online courier of the area with an eligible vehicle of a type asked', () => {
      const courier = online(eligibleApplicant({ marketId }).courier);

      expect(canTakeWork(courier, need(), rules, T0)).toBe(true);
      expect(canTakeWork(courier, need({ coldChain: true }), rules, T0)).toBe(true);
      expect(canTakeWork(courier, need({ vehicleTypes: ['car', 'van'] }), rules, T0)).toBe(true);
    });

    it('is not met in another area, by another vehicle type, offline, or paused', () => {
      const courier = online(eligibleApplicant({ marketId }).courier);

      expect(canTakeWork(courier, need({ serviceAreaCode: 'elsewhere' }), rules, T0)).toBe(false);
      expect(canTakeWork(courier, need({ vehicleTypes: ['bicycle'] }), rules, T0)).toBe(false);
      expect(canTakeWork({ ...courier, shift: 'offline' }, need(), rules, T0)).toBe(false);
      expect(canTakeWork({ ...courier, shift: 'paused' }, need(), rules, T0)).toBe(false);
      expect(canTakeWork({ ...courier, status: 'suspended' }, need(), rules, T0)).toBe(false);
    });

    it('is not met once a document expired, though the courier is still online', () => {
      const courier = online(eligibleApplicant({ marketId }).courier);
      const later = T0.add({ hours: 24 * 366 });

      expect(canTakeWork(courier, need(), rules, later)).toBe(false);
    });
  });
});
