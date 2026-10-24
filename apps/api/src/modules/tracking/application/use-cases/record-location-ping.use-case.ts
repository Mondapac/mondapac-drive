import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { LOCATION_RECORD } from '../../contracts/permissions';
import type { Breadcrumb } from '../../domain/breadcrumb';
import { livePositionOf } from '../../domain/live-position';
import { checkPing, type LocationPing } from '../../domain/location-ping';
import { recordsTrail } from '../../domain/tracked-delivery';
import { ACCESS_DENIED, courierOf } from '../callers';
import { failure, type TrackingFailure } from '../failure';
import type { LivePositionStore, TrackingRepository, TrackingSettingsProvider } from '../ports';

/** What the courier app sends: never a courier id, which is the session's. */
export interface LocationPingInput {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly headingDeg?: number;
  readonly speedKmh?: number;
  readonly recordedAt: Temporal.Instant;
  readonly serviceArea?: string;
}

/** The most pings one request carries (the courier app batches background fixes). */
export const MAX_PINGS_PER_REQUEST = 20;

export interface PingBatchInput {
  readonly pings: readonly LocationPingInput[];
}

/** A ping of the batch the domain refused: its position in the batch and the code. */
export interface RejectedPing {
  readonly index: number;
  readonly code: string;
  /** Only for `ping.invalid`: the field, never its value. */
  readonly field?: string;
}

export interface PingOutcome {
  /** How many pings of the batch were valid. */
  readonly accepted: number;
  readonly rejected: readonly RejectedPing[];
  /** False when a later reading of the courier was already stored. */
  readonly latest: boolean;
  /** How many breadcrumbs the batch added to the deliveries the courier is carrying. */
  readonly breadcrumbs: number;
}

export interface RecordLocationPingDependencies {
  readonly positions: LivePositionStore;
  readonly tracking: TrackingRepository;
  readonly settings: TrackingSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'ping.invalid': 'The ping is not valid',
  'ping.stale': 'The ping was recorded too long ago',
  'ping.future': 'The ping was recorded in the future',
});

/**
 * A courier's device reports where it has been: a batch of its latest fixes. Each ping is
 * checked against the Market's rules; the batch is throttled per courier, its latest valid ping
 * is saved as the courier's live position, and every valid ping is added to the trail of each
 * delivery the courier is carrying. The courier is the signed-in courier (its account id), so no
 * one can move another courier. A batch with no valid ping answers the first refusal.
 * Coordinates never reach a log or a refusal. Rule `permissions [tracking.location.record]`,
 * couriers only.
 */
export class RecordLocationPing extends UseCase<PingBatchInput, PingOutcome, TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.record-location-ping',
    rule: { kind: 'permissions', allOf: [LOCATION_RECORD.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RecordLocationPingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PingBatchInput,
  ): Promise<Result<PingOutcome, TrackingFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    if (input.pings.length === 0 || input.pings.length > MAX_PINGS_PER_REQUEST) {
      return err(failure('ping.invalid', 'The batch is empty or too large', { field: 'pings' }));
    }
    const { market } = context;
    const { positions, tracking, unitOfWork, clock } = this.deps;
    const settings = this.deps.settings.get(market.marketId);
    const now = clock.now();

    const valid: LocationPing[] = [];
    const rejected: RejectedPing[] = [];
    input.pings.forEach((item, index) => {
      const ping = pingOf(courierId, item);
      const checked = checkPing(settings, ping, now);
      if (checked.ok) {
        valid.push(ping);
      } else {
        const refusal = checked.error;
        rejected.push({
          index,
          code: refusal.code,
          ...(refusal.code === 'ping.invalid' ? { field: refusal.field } : {}),
        });
      }
    });
    const first = rejected[0];
    if (valid.length === 0 && first !== undefined) {
      return err(
        failure(first.code, REFUSAL_MESSAGES[first.code] ?? 'The ping is not valid', {
          ...(first.field === undefined ? {} : { field: first.field }),
        }),
      );
    }

    const interval = settings.ping.minIntervalSeconds;
    if (!(await positions.claimPingSlot(market, courierId, interval))) {
      return err(
        failure('ping.throttled', 'The courier sent pings too recently', {
          retryAfterSeconds: interval,
        }),
      );
    }
    const newest = valid.reduce((a, b) =>
      Temporal.Instant.compare(b.recordedAt, a.recordedAt) > 0 ? b : a,
    );
    const latest = await positions.save(
      market,
      livePositionOf(newest),
      settings.livePositionTtlSeconds,
    );

    return unitOfWork.run(market, async () => {
      const carried = (await tracking.activeDeliveriesOf(market, courierId)).filter((delivery) =>
        recordsTrail(delivery, courierId),
      );
      const breadcrumbs: Breadcrumb[] = carried.flatMap((delivery) =>
        valid.map((ping) => ({
          deliveryId: delivery.deliveryId,
          courierId,
          point: ping.point,
          accuracyMetres: ping.accuracyMetres,
          recordedAt: ping.recordedAt,
        })),
      );
      if (breadcrumbs.length > 0) await tracking.appendBreadcrumbs(market, breadcrumbs);
      return ok({ accepted: valid.length, rejected, latest, breadcrumbs: breadcrumbs.length });
    });
  }
}

/** The domain's ping of the signed-in courier. checkPing refuses coordinates off the globe. */
function pingOf(courierId: string, input: LocationPingInput): LocationPing {
  return {
    courierId,
    point: { lat: input.lat, lng: input.lng },
    accuracyMetres: input.accuracyM,
    ...(input.headingDeg === undefined ? {} : { headingDegrees: input.headingDeg }),
    ...(input.speedKmh === undefined ? {} : { speedKmh: input.speedKmh }),
    recordedAt: input.recordedAt,
    ...(input.serviceArea === undefined ? {} : { serviceAreaCode: input.serviceArea }),
  };
}
