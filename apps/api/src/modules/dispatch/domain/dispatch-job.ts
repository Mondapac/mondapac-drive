import {
  Temporal,
  type GeoPoint,
  type Id,
  type MarketId,
  type PendingEvent,
} from '@mondapac-drive/shared-kernel';
import type { VehicleType } from './courier';
import type { DispatchSettings } from './dispatch-settings';
import { DispatchDomainError } from './errors';
import {
  COURIER_ASSIGNED,
  JOB_EXHAUSTED,
  OFFER_ACCEPTED,
  OFFER_DECLINED,
  OFFER_EXPIRED,
  OFFER_SENT,
  OFFER_WITHDRAWN,
} from './events/dispatch-events';
import type { DispatchRequirements, RankedCandidate } from './matching';

/**
 * A dispatch job's lifecycle. A scheduled delivery's job WAITs until it opens; OFFERING sends
 * waves of offers until a courier accepts (ASSIGNED) or every round went unanswered
 * (EXHAUSTED, for a dispatcher). Once the courier collected the parcel the job is COLLECTED:
 * custody can no longer change through dispatch. A dispatcher may assign from any status but
 * COLLECTED and CANCELLED.
 */
export const JOB_STATUSES = [
  'WAITING',
  'OFFERING',
  'ASSIGNED',
  'EXHAUSTED',
  'COLLECTED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const ASSIGNMENT_METHODS = ['offer', 'manual'] as const;
export type AssignmentMethod = (typeof ASSIGNMENT_METHODS)[number];

export interface Offer {
  readonly id: Id<'DispatchOffer'>;
  readonly courierId: Id<'Courier'>;
  readonly vehicle: VehicleType;
  readonly round: number;
  readonly sentAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly status: OfferStatus;
  readonly answeredAt?: Temporal.Instant;
}

export interface Assignment {
  readonly courierId: Id<'Courier'>;
  readonly vehicle: VehicleType;
  readonly method: AssignmentMethod;
  readonly at: Temporal.Instant;
}

/**
 * Where a stop is, as an offer shows it before the courier accepts (security L3): its suburb and
 * postcode, never the street address, which the courier sees on delivery's job after accepting.
 * The suburb is null when delivery has none (a stop booked by its point, or no locality).
 */
export interface OfferArea {
  readonly suburb: string | null;
  readonly postcode: string;
}

/**
 * What a courier's offer shows besides the requirements: the suburb and postcode of both stops,
 * the drop-off point and the trip distance. Location data, so the job holds it only while
 * OFFERING: a scheduled job reads it when it opens, it is dropped once a courier has the
 * delivery, every round lapsed or the delivery was cancelled, and it is read again from the
 * delivery when offering restarts.
 */
export interface OfferStops {
  readonly pickupArea: OfferArea;
  readonly dropoffArea: OfferArea;
  readonly dropoff: GeoPoint;
  readonly tripDistanceMetres: number;
}

export interface DispatchJob {
  readonly id: Id<'DispatchJob'>;
  readonly marketId: MarketId;
  readonly deliveryId: Id<'Delivery'>;
  readonly requirements: DispatchRequirements;
  /** Present only while OFFERING (read again when absent and a wave is due). */
  readonly stops?: OfferStops;
  readonly status: JobStatus;
  /** When offering starts: at once for on-demand, the window minus the Market's lead time. */
  readonly opensAt: Temporal.Instant;
  /** Waves sent since offering (re)started. */
  readonly round: number;
  /** When the job next needs the sweep: opening, an offer expiring, or the next wave. */
  readonly nextActionAt?: Temporal.Instant;
  readonly offers: readonly Offer[];
  readonly assignment?: Assignment;
  /** Couriers never offered this delivery again: they dropped it. */
  readonly excludedCourierIds: readonly Id<'Courier'>[];
  /**
   * The delivery's aggregate version of the last delivery event dispatch followed. Events come
   * at least once and in no order: one at or below it is stale and changes nothing.
   */
  readonly deliveryVersion: number;
  readonly createdAt: Temporal.Instant;
  /** Optimistic-concurrency version, bumped on every change. */
  readonly version: number;
}

/** A change to a job and the events it publishes, appended in the same unit. */
export interface JobChange {
  readonly job: DispatchJob;
  readonly events: readonly PendingEvent[];
}

export interface NewDispatchJob {
  readonly id: Id<'DispatchJob'>;
  readonly marketId: MarketId;
  readonly deliveryId: Id<'Delivery'>;
  readonly requirements: DispatchRequirements;
  /** Kept only when the job opens at once; a scheduled job reads them again when it opens. */
  readonly stops: OfferStops;
  /** The start of a scheduled delivery's window; absent for on-demand. */
  readonly windowStart?: Temporal.Instant;
  /** The delivery's aggregate version the job was opened from (its booking event). */
  readonly deliveryVersion: number;
}

/** Opens the dispatch job of a delivery. Offering starts at once, or the lead time before the window. */
export function openDispatchJob(
  input: NewDispatchJob,
  now: Temporal.Instant,
  settings: Pick<DispatchSettings, 'scheduledLeadMinutes'>,
): DispatchJob {
  const scheduledOpen = input.windowStart?.subtract({ minutes: settings.scheduledLeadMinutes });
  const opensAt =
    scheduledOpen !== undefined && Temporal.Instant.compare(scheduledOpen, now) > 0
      ? scheduledOpen
      : now;
  const offering = opensAt === now;
  return {
    id: input.id,
    marketId: input.marketId,
    deliveryId: input.deliveryId,
    requirements: input.requirements,
    ...(offering ? { stops: input.stops } : {}),
    status: offering ? 'OFFERING' : 'WAITING',
    opensAt,
    round: 0,
    nextActionAt: opensAt,
    offers: [],
    excludedCourierIds: [],
    deliveryVersion: input.deliveryVersion,
    createdAt: now,
    version: 1,
  };
}

const isDue = (at: Temporal.Instant | undefined, now: Temporal.Instant): boolean =>
  at === undefined || Temporal.Instant.compare(at, now) <= 0;

export function isOpen(job: DispatchJob): boolean {
  return job.status === 'WAITING' || job.status === 'OFFERING';
}

export function pendingOffers(job: DispatchJob): Offer[] {
  return job.offers.filter((offer) => offer.status === 'PENDING');
}

/** The couriers never offered this delivery (again): those who declined it or dropped it. */
export function couriersNotToOffer(job: DispatchJob): ReadonlySet<string> {
  const declined = job.offers.filter((o) => o.status === 'DECLINED').map((o) => o.courierId);
  return new Set<string>([...declined, ...job.excludedCourierIds]);
}

/** What the sweep found on a job: the change so far, and whether a new wave is due. */
export interface Swept extends JobChange {
  readonly changed: boolean;
  /** True when the job just left WAITING. */
  readonly opened: boolean;
  readonly waveDue: boolean;
}

/**
 * The time-driven part of a job: opens a WAITING job whose time has come, expires the offers
 * whose time ran out, and exhausts the job when its last round went unanswered. Says whether a
 * new wave is due; the caller then finds candidates and calls {@link sendWave}.
 */
export function sweep(
  job: DispatchJob,
  now: Temporal.Instant,
  settings: Pick<DispatchSettings, 'maxRounds'>,
): Swept {
  const unchanged = { job, events: [], changed: false, opened: false, waveDue: false };
  if (!isOpen(job)) return unchanged;
  if (job.status === 'WAITING' && !isDue(job.opensAt, now)) return unchanged;

  const opened = job.status === 'WAITING';
  const events: PendingEvent[] = [];
  const offers = job.offers.map((offer) => {
    if (offer.status !== 'PENDING' || !isDue(offer.expiresAt, now)) return offer;
    events.push(offerEvent(OFFER_EXPIRED, job, offer, now));
    return { ...offer, status: 'EXPIRED' as const, answeredAt: now };
  });
  const stillPending = offers.filter((offer) => offer.status === 'PENDING');
  if (!opened && events.length === 0) {
    const waveDue = stillPending.length === 0 && isDue(job.nextActionAt, now);
    if (!waveDue || job.round < settings.maxRounds) return { ...unchanged, waveDue };
  }

  const version = job.version + 1;
  if (stillPending.length > 0) {
    const nextActionAt = stillPending
      .map((offer) => offer.expiresAt)
      .reduce((a, b) => (Temporal.Instant.compare(a, b) <= 0 ? a : b));
    return {
      job: { ...job, status: 'OFFERING', offers, nextActionAt, version },
      events,
      changed: true,
      opened,
      waveDue: false,
    };
  }
  if (job.round >= settings.maxRounds) {
    events.push(
      JOB_EXHAUSTED.record({
        aggregateId: job.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { deliveryId: job.deliveryId, rounds: job.round },
      }),
    );
    const rest = closed(job);
    return {
      job: { ...rest, status: 'EXHAUSTED', offers, version },
      events,
      changed: true,
      opened,
      waveDue: false,
    };
  }
  return {
    job: { ...job, status: 'OFFERING', offers, nextActionAt: now, version },
    events,
    changed: true,
    opened,
    waveDue: true,
  };
}

/**
 * Sends the next wave: offers to the first `waveSize` candidates, each with the Market's
 * accept timeout. Couriers never offered this delivery go first; one whose earlier offer
 * expired may get it again after them; one who declined or dropped it never does. With no
 * candidate the round still counts, and the next wave is tried after one timeout, so that
 * couriers coming on shift get their chance.
 */
export function sendWave(
  job: DispatchJob,
  candidates: readonly RankedCandidate[],
  now: Temporal.Instant,
  settings: Pick<DispatchSettings, 'waveSize' | 'offerTimeoutSeconds' | 'maxRounds'>,
  nextOfferId: () => Id<'DispatchOffer'>,
): JobChange {
  if (job.status !== 'OFFERING') {
    throw new DispatchDomainError('dispatch.not-offering', `The job is ${job.status}`);
  }
  if (pendingOffers(job).length > 0 || job.round >= settings.maxRounds) {
    throw new DispatchDomainError('dispatch.wave-not-due', 'No wave is due on this job');
  }
  const skip = couriersNotToOffer(job);
  const offeredBefore = new Set<string>(job.offers.map((o) => o.courierId));
  const eligible = candidates.filter((c) => !skip.has(c.courierId));
  const chosen = [
    ...eligible.filter((c) => !offeredBefore.has(c.courierId)),
    ...eligible.filter((c) => offeredBefore.has(c.courierId)),
  ].slice(0, settings.waveSize);
  const round = job.round + 1;
  const expiresAt = now.add({ seconds: settings.offerTimeoutSeconds });
  const sent: Offer[] = chosen.map((candidate) => ({
    id: nextOfferId(),
    courierId: candidate.courierId,
    vehicle: candidate.vehicle,
    round,
    sentAt: now,
    expiresAt,
    status: 'PENDING',
  }));
  return {
    job: {
      ...job,
      round,
      offers: [...job.offers, ...sent],
      nextActionAt: expiresAt,
      version: job.version + 1,
    },
    events: sent.map((offer) =>
      OFFER_SENT.record({
        aggregateId: offer.id,
        aggregateVersion: 1,
        occurredAt: now,
        payload: {
          jobId: job.id,
          deliveryId: job.deliveryId,
          courierId: offer.courierId,
          round,
          expiresAt,
        },
      }),
    ),
  };
}

/** The offer of this id made to this courier, or undefined: another courier's offer is unknown. */
export function offerOf(
  job: DispatchJob,
  offerId: Id<'DispatchOffer'>,
  courierId: Id<'Courier'>,
): Offer | undefined {
  return job.offers.find((o) => o.id === offerId && o.courierId === courierId);
}

/** The courier's pending offer on the job that has not expired at `now`, or undefined. */
export function openOfferOf(
  job: DispatchJob,
  courierId: Id<'Courier'>,
  now: Temporal.Instant,
): Offer | undefined {
  if (job.status !== 'OFFERING') return undefined;
  return job.offers.find(
    (o) => o.courierId === courierId && o.status === 'PENDING' && !isDue(o.expiresAt, now),
  );
}

/**
 * A courier accepts or declines the pending offer `offerId` made to them, before it expires.
 * An offer made to another courier is refused as if it did not exist.
 */
export function answerOffer(
  job: DispatchJob,
  offerId: Id<'DispatchOffer'>,
  courierId: Id<'Courier'>,
  answer: 'accept' | 'decline',
  now: Temporal.Instant,
): JobChange {
  const offer = offerOf(job, offerId, courierId);
  if (job.status !== 'OFFERING' || offer?.status !== 'PENDING') {
    throw new DispatchDomainError('offer.not-pending', 'This courier has no open offer on the job');
  }
  if (isDue(offer.expiresAt, now)) {
    throw new DispatchDomainError('offer.expired', 'The offer has expired');
  }
  const version = job.version + 1;
  if (answer === 'decline') {
    const offers = job.offers.map((o) =>
      o.id === offer.id ? { ...o, status: 'DECLINED' as const, answeredAt: now } : o,
    );
    const othersPending = offers.some((o) => o.status === 'PENDING');
    return {
      job: { ...job, offers, nextActionAt: othersPending ? job.nextActionAt : now, version },
      events: [offerEvent(OFFER_DECLINED, job, offer, now)],
    };
  }

  const events: PendingEvent[] = [offerEvent(OFFER_ACCEPTED, job, offer, now)];
  const offers = job.offers.map((o) => {
    if (o.id === offer.id) return { ...o, status: 'ACCEPTED' as const, answeredAt: now };
    if (o.status !== 'PENDING') return o;
    events.push(offerEvent(OFFER_WITHDRAWN, job, o, now));
    return { ...o, status: 'WITHDRAWN' as const, answeredAt: now };
  });
  const assignment: Assignment = { courierId, vehicle: offer.vehicle, method: 'offer', at: now };
  events.push(assignedEvent(job, assignment, version, undefined));
  const rest = closed(job);
  return { job: { ...rest, status: 'ASSIGNED', offers, assignment, version }, events };
}

/**
 * A dispatcher assigns the delivery to a courier: while offers are out (they are withdrawn),
 * after the job was exhausted, before a scheduled job opened, or to replace the assigned courier.
 */
export function assignManually(
  job: DispatchJob,
  courierId: Id<'Courier'>,
  vehicle: VehicleType,
  now: Temporal.Instant,
): JobChange {
  if (job.status === 'CANCELLED') {
    throw new DispatchDomainError('dispatch.cancelled', 'The delivery was cancelled');
  }
  if (job.status === 'COLLECTED') {
    throw new DispatchDomainError(
      'dispatch.collected',
      'The courier collected the parcel: the delivery can no longer be reassigned',
    );
  }
  if (job.assignment?.courierId === courierId) {
    throw new DispatchDomainError('dispatch.already-assigned', 'The courier already has it');
  }
  const version = job.version + 1;
  const { offers, events } = withdrawPending(job, now);
  const assignment: Assignment = { courierId, vehicle, method: 'manual', at: now };
  events.push(assignedEvent(job, assignment, version, job.assignment?.courierId));
  const rest = closed(job);
  return { job: { ...rest, status: 'ASSIGNED', offers, assignment, version }, events };
}

/**
 * The assigned courier dropped the delivery: offering starts again at once, with fresh rounds,
 * and that courier is never offered it again. The offers show `stops`, read again from the
 * delivery.
 */
export function redispatch(job: DispatchJob, stops: OfferStops, now: Temporal.Instant): JobChange {
  if (job.status !== 'ASSIGNED' || job.assignment === undefined) {
    throw new DispatchDomainError(
      'dispatch.not-assigned',
      'Only an assigned job is dispatched again',
    );
  }
  const { assignment, ...rest } = job;
  return {
    job: {
      ...rest,
      stops,
      status: 'OFFERING',
      round: 0,
      nextActionAt: now,
      excludedCourierIds: [...job.excludedCourierIds, assignment.courierId],
      version: job.version + 1,
    },
    events: [],
  };
}

/**
 * A dispatcher tries again after every round went unanswered: offering restarts at once with
 * fresh rounds. Couriers who declined or dropped the delivery are still skipped.
 */
export function restartOffering(job: DispatchJob, now: Temporal.Instant): JobChange {
  if (job.status !== 'EXHAUSTED') {
    throw new DispatchDomainError(
      'dispatch.not-exhausted',
      'Only a job whose rounds all went unanswered is offered again',
    );
  }
  return {
    job: { ...job, status: 'OFFERING', round: 0, nextActionAt: now, version: job.version + 1 },
    events: [],
  };
}

/**
 * The delivery says a courier has it, assigned outside dispatch (a dispatcher on the delivery's
 * own route): offers still out are withdrawn and the job records the courier. The delivery is
 * the source of this fact, so no `dispatch.courier-assigned` is published for it.
 */
export function recordAssignment(
  job: DispatchJob,
  courierId: Id<'Courier'>,
  now: Temporal.Instant,
): JobChange {
  if (
    job.status === 'CANCELLED' ||
    job.status === 'COLLECTED' ||
    job.assignment?.courierId === courierId
  ) {
    return { job, events: [] };
  }
  const { offers, events } = withdrawPending(job, now);
  const vehicle = job.assignment?.vehicle ?? job.requirements.minimumVehicle;
  const assignment: Assignment = { courierId, vehicle, method: 'manual', at: now };
  const rest = closed(job);
  return {
    job: { ...rest, status: 'ASSIGNED', offers, assignment, version: job.version + 1 },
    events,
  };
}

/**
 * A dispatcher opened a scheduled delivery for dispatch before its time: the job opens on the
 * next sweep. Any other job is left as it is.
 */
export function openEarly(job: DispatchJob, now: Temporal.Instant): JobChange {
  if (job.status !== 'WAITING' || isDue(job.opensAt, now)) return { job, events: [] };
  return { job: { ...job, opensAt: now, nextActionAt: now, version: job.version + 1 }, events: [] };
}

/** The job after following delivery event `version`: a change bumps the job's own version. */
export function followedDeliveryVersion(
  before: DispatchJob,
  after: DispatchJob,
  version: number,
): DispatchJob {
  return {
    ...after,
    deliveryVersion: version,
    version: after.version === before.version ? before.version + 1 : after.version,
  };
}

/**
 * The delivery says its courier collected the parcel: the job is done for good, and records
 * the courier the delivery names (it wins over a reassignment that raced the pickup).
 */
export function recordCollection(
  job: DispatchJob,
  courierId: Id<'Courier'> | null,
  now: Temporal.Instant,
): JobChange {
  if (job.status === 'COLLECTED' || job.status === 'CANCELLED') return { job, events: [] };
  const { offers, events } = withdrawPending(job, now);
  const held = job.assignment;
  const assignment: Assignment | undefined =
    courierId === null || held?.courierId === courierId
      ? held
      : {
          courierId,
          vehicle: held?.vehicle ?? job.requirements.minimumVehicle,
          method: 'manual',
          at: now,
        };
  const { assignment: dropped, ...rest } = closed(job);
  void dropped;
  return {
    job: {
      ...rest,
      ...(assignment === undefined ? {} : { assignment }),
      status: 'COLLECTED',
      offers,
      version: job.version + 1,
    },
    events,
  };
}

/** The job with the offer's stops, read again for a wave; any other job is left as it is. */
export function withStops(job: DispatchJob, stops: OfferStops): DispatchJob {
  return job.status === 'OFFERING' && job.stops === undefined ? { ...job, stops } : job;
}

/** The delivery was cancelled: offers out are withdrawn and the job stops. */
export function cancelJob(job: DispatchJob, now: Temporal.Instant): JobChange {
  if (job.status === 'CANCELLED' || job.status === 'COLLECTED') return { job, events: [] };
  const { offers, events } = withdrawPending(job, now);
  const { assignment, ...rest } = closed(job);
  void assignment;
  return { job: { ...rest, status: 'CANCELLED', offers, version: job.version + 1 }, events };
}

/** The job without a next action: nothing is left for the sweep. */
function settled(job: DispatchJob): Omit<DispatchJob, 'nextActionAt'> {
  const { nextActionAt, ...rest } = job;
  void nextActionAt;
  return rest;
}

/** The job done with offering for good: no next action, and no addresses kept. */
function closed(job: DispatchJob): Omit<DispatchJob, 'nextActionAt' | 'stops'> {
  const { stops, ...rest } = settled(job);
  void stops;
  return rest;
}

function withdrawPending(
  job: DispatchJob,
  now: Temporal.Instant,
): { offers: Offer[]; events: PendingEvent[] } {
  const events: PendingEvent[] = [];
  const offers = job.offers.map((offer) => {
    if (offer.status !== 'PENDING') return offer;
    events.push(offerEvent(OFFER_WITHDRAWN, job, offer, now));
    return { ...offer, status: 'WITHDRAWN' as const, answeredAt: now };
  });
  return { offers, events };
}

type OfferAnswerEvent =
  typeof OFFER_ACCEPTED | typeof OFFER_DECLINED | typeof OFFER_EXPIRED | typeof OFFER_WITHDRAWN;

/** An offer's second and last event: answered, expired or withdrawn. */
function offerEvent(
  definition: OfferAnswerEvent,
  job: DispatchJob,
  offer: Offer,
  now: Temporal.Instant,
): PendingEvent {
  return definition.record({
    aggregateId: offer.id,
    aggregateVersion: 2,
    occurredAt: now,
    payload: { jobId: job.id, deliveryId: job.deliveryId, courierId: offer.courierId },
  });
}

function assignedEvent(
  job: DispatchJob,
  assignment: Assignment,
  version: number,
  previousCourierId: Id<'Courier'> | undefined,
): PendingEvent {
  return COURIER_ASSIGNED.record({
    aggregateId: job.id,
    aggregateVersion: version,
    occurredAt: assignment.at,
    payload: {
      deliveryId: job.deliveryId,
      courierId: assignment.courierId,
      vehicle: assignment.vehicle,
      method: assignment.method,
      previousCourierId: previousCourierId ?? null,
    },
  });
}
