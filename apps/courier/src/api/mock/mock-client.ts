import type { Clock } from '../../platform/clock/clock';
import { checkReading } from '../../domain/cold-chain';
import { ApiError, type CourierApi, type JobEvent } from '../client';
import {
  courierSettings,
  pinInput,
  signInInput,
  type CourierSettings,
  type CourierStatus,
  type EarningsSummary,
  type Job,
  type LocationPing,
  type Offer,
  type Temperature,
  onboardingRules as onboardingRulesSchema,
  plateInput,
  type CourierProfile,
  type OnboardingRules,
} from '../schemas';
import fixture from './mock-market.json';

type FixtureOffer = (typeof fixture.offers)[number];

interface MockOptions {
  readonly clock: Clock;
  /** The Market settings the mock answers with; the bundled fixture by default. */
  readonly settings?: CourierSettings;
  /** The Market's onboarding rules; the bundled fixture by default, null as an API without them. */
  readonly onboardingRules?: OnboardingRules | null;
  /** Start as a courier who has not applied yet (an email starting `new` at sign-in does too). */
  readonly newCourier?: boolean;
}

/** Which event may follow which status, as the delivery API enforces it. */
const FROM: Readonly<Record<JobEvent['type'], readonly Job['status'][]>> = {
  arrived_at_pickup: ['ASSIGNED'],
  picked_up: ['AT_PICKUP'],
  arrived_at_dropoff: ['PICKED_UP'],
  delivered: ['AT_DROPOFF'],
  delivery_failed: ['PICKED_UP', 'AT_DROPOFF'],
};
const TO: Readonly<Record<JobEvent['type'], Job['status']>> = {
  arrived_at_pickup: 'AT_PICKUP',
  picked_up: 'PICKED_UP',
  arrived_at_dropoff: 'AT_DROPOFF',
  delivered: 'DELIVERED',
  delivery_failed: 'DELIVERY_FAILED',
};

/**
 * An in-memory backend: the app runs with it before the API routes exist (EXPO_PUBLIC_API_MODE
 * mock), and the screen tests drive it. It answers like the API: it refuses an event out of
 * order, a missing or out-of-limit cold-chain reading and a wrong PIN.
 */
/** Wrong PINs the mock takes per delivery before it closes PIN entry (the API's is per Market). */
export const MOCK_PIN_ATTEMPTS = 3;

/** How long after the last submission the mock's operator approves the courier and documents. */
export const MOCK_REVIEW_MS = 10_000;

/** A courier the operator has approved, with a verified vehicle: the mock's default. */
function activeCourier(rules: OnboardingRules | null): CourierProfile {
  const car = rules?.vehicleClasses.find((vehicle) => vehicle.type === 'car');
  return {
    id: 'mock-courier-1',
    status: 'active',
    employmentType: 'employee',
    coldChainCapable: true,
    serviceAreaCode: rules?.serviceAreas[0]?.code ?? 'mock-area',
    vehicles: [
      {
        id: 'mock-vehicle-1',
        type: 'car',
        plate: 'MOCK01',
        maxWeightGrams: car?.maxWeightGrams ?? 50_000,
        maxVolumeLitres: car?.maxVolumeLitres ?? 300,
        coldBox: 'insulated',
        active: true,
      },
    ],
    documents: [],
  };
}

export function createMockCourierApi(options: MockOptions) {
  const settings = courierSettings.parse(options.settings ?? fixture.settings);
  const clock = options.clock;
  let signedIn = false;
  let status: CourierStatus = { shift: 'offline', activeDeliveryId: null };
  let pending: Offer | null = null;
  let offerCount = 0;
  const jobs = new Map<string, Job>();
  const pings: LocationPing[] = [];
  const events: { deliveryId: string; event: JobEvent }[] = [];
  const pinAttempts = new Map<string, number>();
  let earnedToday = 0n;
  let deliveriesToday = 0;
  const rules =
    options.onboardingRules === undefined
      ? onboardingRulesSchema.parse(fixture.onboarding)
      : options.onboardingRules;
  let profile: CourierProfile | null = options.newCourier ? null : activeCourier(rules);
  let lastSubmissionAt: number | null = null;
  let nextId = 0;
  const uploads: { type: string; uri: string; mimeType: string }[] = [];

  function requireProfile(): CourierProfile {
    requireSession();
    if (!profile) throw new ApiError(404, 'fleet.courier.not-found');
    return profile;
  }

  /** The mock's operator: some time after the last submission, everything submitted is approved. */
  function review(): void {
    if (!profile || lastSubmissionAt === null) return;
    if (clock.now() - lastSubmissionAt < MOCK_REVIEW_MS) return;
    lastSubmissionAt = null;
    profile = {
      ...profile,
      status: profile.status === 'applicant' ? 'active' : profile.status,
      documents: profile.documents.map((document) =>
        document.status === 'submitted' ? { ...document, status: 'verified' } : document,
      ),
    };
  }

  const money = (amount: bigint) => ({ amount: amount.toString(), currency: settings.currency });

  function requireSession(): void {
    if (!signedIn) throw new ApiError(401, 'session.missing');
  }

  function nextOffer(): Offer {
    const source: FixtureOffer = fixture.offers[offerCount % fixture.offers.length]!;
    offerCount += 1;
    const deliveryId = `mock-delivery-${offerCount}`;
    jobs.set(deliveryId, {
      id: deliveryId,
      status: 'ASSIGNED',
      pickup: source.pickup,
      dropoff: source.dropoff,
      parcel: { ...source.parcel, temperature: source.temperature as Temperature },
    });
    return {
      id: `mock-offer-${offerCount}`,
      deliveryId,
      expiresAt: new Date(clock.now() + settings.offerAcceptSeconds * 1000).toISOString(),
      pickup: { address: source.pickup.address, point: source.pickup.point },
      dropoff: { address: source.dropoff.address, point: source.dropoff.point },
      distanceMetres: source.distanceMetres,
      earnings: money(BigInt(source.earnings)),
      temperature: source.temperature as Temperature,
    };
  }

  function earningsOf(deliveryId: string): bigint {
    const index = Number(deliveryId.split('-').pop()) - 1;
    const source = fixture.offers[index % fixture.offers.length];
    return BigInt(source?.earnings ?? '0');
  }

  const api: CourierApi = {
    signIn(input) {
      const parsed = signInInput.safeParse(input);
      if (!parsed.success) return Promise.reject(new ApiError(400, 'validation.failed'));
      if (parsed.data.password === fixture.wrongPassword) {
        return Promise.reject(new ApiError(401, 'credentials.invalid'));
      }
      signedIn = true;
      if (parsed.data.email.startsWith('new')) profile = null;
      return Promise.resolve({
        token: 'mock-session-token-0000000000',
        marketId: settings.marketId,
      });
    },
    signOut() {
      signedIn = false;
      status = { shift: 'offline', activeDeliveryId: null };
      pending = null;
      return Promise.resolve();
    },
    settings() {
      requireSession();
      return Promise.resolve(settings);
    },
    status() {
      requireProfile();
      return Promise.resolve(status);
    },
    setShift(state) {
      requireSession();
      if (state === 'online' && profile?.status !== 'active') {
        return Promise.reject(new ApiError(422, 'fleet.courier.not-active'));
      }
      if (state === 'offline' && status.activeDeliveryId) {
        return Promise.reject(new ApiError(409, 'fleet.shift.transition-not-allowed'));
      }
      status = state === 'online' && status.activeDeliveryId ? status : { ...status, shift: state };
      if (state === 'offline') pending = null;
      return Promise.resolve(status);
    },
    currentOffer() {
      requireSession();
      if (status.shift !== 'online' || status.activeDeliveryId) return Promise.resolve(null);
      if (pending && Date.parse(pending.expiresAt) <= clock.now()) pending = null;
      pending ??= nextOffer();
      return Promise.resolve(pending);
    },
    acceptOffer(offerId) {
      requireSession();
      if (!pending || pending.id !== offerId) {
        return Promise.reject(new ApiError(404, 'offer.not-found'));
      }
      if (Date.parse(pending.expiresAt) <= clock.now()) {
        pending = null;
        return Promise.reject(new ApiError(409, 'offer.expired'));
      }
      const deliveryId = pending.deliveryId;
      const job = jobs.get(deliveryId)!;
      jobs.set(deliveryId, { ...job, courierId: 'mock-courier-1' });
      status = { shift: 'on_delivery', activeDeliveryId: deliveryId };
      pending = null;
      return Promise.resolve({ deliveryId });
    },
    declineOffer(offerId) {
      requireSession();
      if (pending?.id === offerId) pending = null;
      return Promise.resolve();
    },
    job(deliveryId) {
      requireSession();
      const job = jobs.get(deliveryId);
      return job ? Promise.resolve(job) : Promise.reject(new ApiError(404, 'delivery.not-found'));
    },
    recordEvent(deliveryId, event) {
      requireSession();
      const job = jobs.get(deliveryId);
      if (!job) return Promise.reject(new ApiError(404, 'delivery.not-found'));
      if (!FROM[event.type].includes(job.status)) {
        return Promise.reject(new ApiError(422, 'delivery.invalid-transition'));
      }
      if (event.type === 'picked_up' || event.type === 'delivered') {
        const reading = event.temperatureCelsius;
        const check = checkReading(
          job.parcel.temperature,
          reading === undefined ? '' : String(reading),
          settings.coldChain,
        );
        if (check.kind === 'missing' || check.kind === 'invalid') {
          return Promise.reject(new ApiError(422, 'cold-chain.reading-required'));
        }
        if (check.kind === 'breach') return Promise.reject(new ApiError(422, 'cold-chain.breach'));
      }
      if (event.type === 'delivered' && event.proof.kind === 'pin') {
        // As the API: a wrong PIN uses an attempt, and once they are used up PIN entry closes.
        const used = pinAttempts.get(deliveryId) ?? 0;
        if (used >= MOCK_PIN_ATTEMPTS) {
          return Promise.reject(new ApiError(423, 'delivery.pin-locked'));
        }
        if (
          !pinInput.safeParse(event.proof.pin).success ||
          event.proof.pin !== fixture.deliveryPin
        ) {
          pinAttempts.set(deliveryId, used + 1);
          return Promise.reject(new ApiError(422, 'delivery.pin-wrong'));
        }
      }
      const updated: Job = { ...job, status: TO[event.type] };
      jobs.set(deliveryId, updated);
      events.push({ deliveryId, event });
      if (event.type === 'delivered') {
        earnedToday += earningsOf(deliveryId);
        deliveriesToday += 1;
      }
      if (event.type === 'delivered' || event.type === 'delivery_failed') {
        status = { shift: 'online', activeDeliveryId: null };
      }
      return Promise.resolve(updated);
    },
    uploadProofPhoto(deliveryId) {
      requireSession();
      if (!jobs.has(deliveryId)) return Promise.reject(new ApiError(404, 'delivery.not-found'));
      return Promise.resolve({ photoRef: `mock/proof/${deliveryId}.jpg` });
    },
    sendPings(batch) {
      requireSession();
      pings.push(...batch);
      return Promise.resolve();
    },
    earnings(): Promise<EarningsSummary> {
      requireSession();
      return Promise.resolve({
        today: money(earnedToday),
        week: money(earnedToday),
        deliveriesToday,
      });
    },
    profile() {
      requireSession();
      review();
      return Promise.resolve(profile);
    },
    onboardingRules() {
      requireSession();
      return Promise.resolve(rules);
    },
    applyAsCourier(input) {
      requireSession();
      if (profile) return Promise.resolve(profile);
      if (!rules?.serviceAreas.some((area) => area.code === input.serviceAreaCode)) {
        return Promise.reject(new ApiError(422, 'fleet.service-area.unknown'));
      }
      profile = {
        id: 'mock-courier-1',
        status: 'applicant',
        employmentType: input.employmentType,
        coldChainCapable: input.coldChainCapable,
        serviceAreaCode: input.serviceAreaCode,
        vehicles: [],
        documents: [],
      };
      return Promise.resolve(profile);
    },
    addVehicle(input) {
      const current = requireProfile();
      const vehicleClass = rules?.vehicleClasses.find((vehicle) => vehicle.type === input.type);
      if (!vehicleClass) return Promise.reject(new ApiError(422, 'fleet.vehicle.type-not-offered'));
      const plate = input.plate === undefined ? undefined : plateInput.safeParse(input.plate);
      if (plate && !plate.success) {
        return Promise.reject(new ApiError(422, 'fleet.vehicle.plate-invalid'));
      }
      if (!plate && input.type !== 'bicycle') {
        return Promise.reject(new ApiError(422, 'fleet.vehicle.plate-required'));
      }
      nextId += 1;
      profile = {
        ...current,
        vehicles: [
          ...current.vehicles,
          {
            id: `mock-vehicle-${nextId + 1}`,
            type: input.type,
            plate: plate?.data ?? null,
            maxWeightGrams: vehicleClass.maxWeightGrams,
            maxVolumeLitres: vehicleClass.maxVolumeLitres,
            coldBox: input.coldBox,
            active: true,
          },
        ],
      };
      return Promise.resolve(profile);
    },
    submitDocument(upload) {
      const current = requireProfile();
      const requirement = rules?.documents.find((document) => document.type === upload.type);
      if (!requirement) return Promise.reject(new ApiError(422, 'fleet.document.type-unknown'));
      if (requirement.expires && upload.expiresAt === undefined) {
        return Promise.reject(new ApiError(422, 'fleet.document.expiry-required'));
      }
      if (!requirement.expires && upload.expiresAt !== undefined) {
        return Promise.reject(new ApiError(422, 'fleet.document.expiry-not-allowed'));
      }
      if (upload.expiresAt !== undefined && Date.parse(upload.expiresAt) <= clock.now()) {
        return Promise.reject(new ApiError(422, 'fleet.document.expired'));
      }
      if (requirement.perVehicle !== (upload.vehicleId !== undefined)) {
        return Promise.reject(
          new ApiError(
            422,
            requirement.perVehicle
              ? 'fleet.document.vehicle-required'
              : 'fleet.document.vehicle-not-allowed',
          ),
        );
      }
      if (
        upload.vehicleId !== undefined &&
        !current.vehicles.some((vehicle) => vehicle.id === upload.vehicleId)
      ) {
        return Promise.reject(new ApiError(404, 'fleet.vehicle.not-found'));
      }
      nextId += 1;
      uploads.push({ type: upload.type, uri: upload.file.uri, mimeType: upload.file.mimeType });
      lastSubmissionAt = clock.now();
      profile = {
        ...current,
        documents: [
          ...current.documents,
          {
            id: `mock-document-${nextId}`,
            type: upload.type,
            vehicleId: upload.vehicleId ?? null,
            expiresAt: upload.expiresAt ?? null,
            status: 'submitted',
            rejectionReason: null,
          },
        ],
      };
      return Promise.resolve(profile);
    },
    payoutOnboardingLink() {
      const current = requireProfile();
      if (current.employmentType !== 'contractor') {
        return Promise.reject(new ApiError(409, 'payouts.not-a-contractor'));
      }
      return Promise.resolve({
        url: 'https://connect.example.test/onboarding/mock-courier-1',
        expiresAt: new Date(clock.now() + 5 * 60 * 1000).toISOString(),
      });
    },
  };

  /** What tests read back. */
  const inspect = {
    pings: (): readonly LocationPing[] => pings,
    events: () => events,
    pin: fixture.deliveryPin,
    wrongPassword: fixture.wrongPassword,
    uploads: () => uploads,
    /** The mock's operator rejects a submitted document, as fleet's operator route does. */
    rejectDocument: (documentId: string, reason: string) => {
      if (!profile) return;
      profile = {
        ...profile,
        documents: profile.documents.map((document) =>
          document.id === documentId
            ? { ...document, status: 'rejected', rejectionReason: reason }
            : document,
        ),
      };
    },
  };
  return { api, inspect };
}
