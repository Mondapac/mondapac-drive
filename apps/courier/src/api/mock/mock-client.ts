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
} from '../schemas';
import fixture from './mock-market.json';

type FixtureOffer = (typeof fixture.offers)[number];

interface MockOptions {
  readonly clock: Clock;
  /** The Market settings the mock answers with; the bundled fixture by default. */
  readonly settings?: CourierSettings;
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
  let earnedToday = 0n;
  let deliveriesToday = 0;

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
      signedIn = true;
      return Promise.resolve({
        token: 'mock-session-token-0000000000',
        courierId: 'mock-courier-1',
        marketId: settings.marketId,
        displayName: 'Mock Courier',
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
      requireSession();
      return Promise.resolve(status);
    },
    setShift(state) {
      requireSession();
      if (state === 'offline' && status.activeDeliveryId) {
        return Promise.reject(new ApiError(409, 'shift.delivery-in-progress'));
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
        if (
          !pinInput.safeParse(event.proof.pin).success ||
          event.proof.pin !== fixture.deliveryPin
        ) {
          return Promise.reject(new ApiError(422, 'proof.pin-mismatch'));
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
  };

  /** What tests read back. */
  const inspect = {
    pings: (): readonly LocationPing[] => pings,
    events: () => events,
    pin: fixture.deliveryPin,
  };
  return { api, inspect };
}
