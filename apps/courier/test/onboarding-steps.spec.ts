import type { CourierProfile } from '../src/api/schemas';
import {
  documentSlots,
  expiryInstant,
  humanise,
  onboardingStep,
  slotStatus,
} from '../src/screens/onboarding/onboarding-steps';
import { ONBOARDING_MARKETS } from './onboarding-markets';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const [AU, ZZ] = ONBOARDING_MARKETS as unknown as [
  (typeof ONBOARDING_MARKETS)[number],
  (typeof ONBOARDING_MARKETS)[number],
];

function applicant(overrides: Partial<CourierProfile> = {}): CourierProfile {
  return {
    id: 'c-1',
    status: 'applicant',
    employmentType: 'employee',
    coldChainCapable: false,
    serviceAreaCode: 'area',
    vehicles: [],
    documents: [],
    ...overrides,
  };
}

const vehicle = (id: string, type: 'bicycle' | 'motorbike' | 'car' | 'van') => ({
  id,
  type,
  plate: type === 'bicycle' ? null : 'ABC123',
  maxWeightGrams: 1000,
  maxVolumeLitres: 10,
  coldBox: 'none' as const,
  active: true,
});

const types = (profile: CourierProfile, rules: typeof AU.rules) =>
  documentSlots(profile, rules).map(
    (slot) => `${slot.requirement.type}${slot.vehicle ? `@${slot.vehicle.id}` : ''}`,
  );

describe('documents a courier owes', () => {
  it('in AU: a contractor with a car owes the business id, licence, its registration and more', () => {
    const profile = applicant({ employmentType: 'contractor', vehicles: [vehicle('v1', 'car')] });
    expect(types(profile, AU.rules)).toEqual([
      'abn',
      'driver_licence',
      'vehicle_registration@v1',
      'insurance',
      'police_check',
    ]);
  });

  it('in AU: an employee on a bicycle owes no licence; cold chain adds food handling', () => {
    const profile = applicant({ coldChainCapable: true, vehicles: [vehicle('v1', 'bicycle')] });
    expect(types(profile, AU.rules)).toEqual(['police_check', 'food_handling']);
  });

  it('in ZZ: the Market’s own codes, one inspection per van', () => {
    const profile = applicant({
      employmentType: 'contractor',
      coldChainCapable: true,
      vehicles: [vehicle('v1', 'van'), vehicle('v2', 'van'), vehicle('v3', 'motorbike')],
    });
    expect(types(profile, ZZ.rules)).toEqual([
      'business_number',
      'driving_permit',
      'vehicle_inspection@v1',
      'vehicle_inspection@v2',
      'cold_chain_training',
    ]);
  });

  it('ignores a vehicle taken out of use', () => {
    const profile = applicant({ vehicles: [{ ...vehicle('v1', 'van'), active: false }] });
    expect(types(profile, ZZ.rules)).toEqual([]);
  });
});

describe.each(ONBOARDING_MARKETS)('onboarding step in $settings.marketId', ({ rules }) => {
  const motor = rules.vehicleClasses.find((v) => v.type !== 'bicycle')!.type;

  it('walks profile, vehicle, documents, waiting and ready from the server profile', () => {
    expect(onboardingStep(null, rules, NOW).kind).toBe('profile');
    const applied = applicant({ employmentType: 'contractor' });
    expect(onboardingStep(applied, rules, NOW).kind).toBe('vehicle');
    const withVehicle = { ...applied, vehicles: [vehicle('v1', motor)] };
    const documents = onboardingStep(withVehicle, rules, NOW);
    expect(documents.kind).toBe('documents');
    const slots = documents.kind === 'documents' ? documents.slots : [];
    const submitted: CourierProfile = {
      ...withVehicle,
      documents: slots.map((slot, i) => ({
        id: `d${i}`,
        type: slot.requirement.type,
        vehicleId: slot.vehicle?.id ?? null,
        expiresAt: slot.requirement.expires ? '2027-01-01T00:00:00Z' : null,
        status: 'submitted',
        rejectionReason: null,
      })),
    };
    expect(onboardingStep(submitted, rules, NOW).kind).toBe('waiting');
    expect(onboardingStep({ ...submitted, status: 'active' }, rules, NOW).kind).toBe('ready');
  });

  it('asks again for a rejected or expired document, and blocks a suspended courier', () => {
    const profile = applicant({ employmentType: 'contractor', vehicles: [vehicle('v1', motor)] });
    const [first] = documentSlots(profile, rules);
    const rejected = slotStatus(
      first!,
      {
        ...profile,
        documents: [
          {
            id: 'd1',
            type: first!.requirement.type,
            vehicleId: null,
            expiresAt: null,
            status: 'rejected',
            rejectionReason: 'illegible',
          },
        ],
      },
      NOW,
    );
    expect(rejected.state).toBe('rejected');
    const expired = slotStatus(
      first!,
      {
        ...profile,
        documents: [
          {
            id: 'd1',
            type: first!.requirement.type,
            vehicleId: null,
            expiresAt: '2026-10-01T00:00:00Z',
            status: 'verified',
            rejectionReason: null,
          },
        ],
      },
      NOW,
    );
    expect(expired.state).toBe('expired');
    expect(onboardingStep({ ...profile, status: 'suspended' }, rules, NOW)).toEqual({
      kind: 'blocked',
      standing: 'suspended',
    });
  });
});

describe('expiry date', () => {
  it('is good through the day it names', () => {
    expect(expiryInstant('2027-02-28', NOW)).toEqual({ ok: true, value: '2027-02-28T23:59:59Z' });
    expect(expiryInstant(' 2026-10-24 ', NOW)).toEqual({ ok: true, value: '2026-10-24T23:59:59Z' });
  });

  it('refuses a past day and a date that does not exist', () => {
    expect(expiryInstant('2026-10-23', NOW)).toEqual({ ok: false, reason: 'past' });
    expect(expiryInstant('2027-02-30', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(expiryInstant('28/02/2027', NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});

it('turns a Market code into words', () => {
  expect(humanise('greater-brisbane')).toBe('Greater Brisbane');
  expect(humanise('cold_chain_training')).toBe('Cold Chain Training');
});
