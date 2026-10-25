import type { Id, MarketContext, MarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { CourierState } from '../domain/courier';
import type { CourierJob } from '../domain/courier-job';
import type { CourierStatus } from '../domain/courier-status';
import type { DocumentRequirement, MarketFleetRules } from '../domain/fleet-rules';
import type { Temperature, VehicleType } from '../domain/vehicle';

/**
 * The couriers of one Market. Every method runs inside the caller's unit of work
 * (`platform/unit-of-work`): reads in a read-only or read-write unit, writes in a read-write one.
 */
export interface CourierRepository {
  findById(market: MarketContext, id: Id<'Courier'>): Promise<CourierState | undefined>;
  findByActorId(market: MarketContext, actorId: string): Promise<CourierState | undefined>;
  /** The couriers of these accounts in the Market, whatever their standing. */
  findByActorIds(market: MarketContext, actorIds: readonly string[]): Promise<CourierState[]>;
  /**
   * Inserts a newly registered courier (version 1). Answers false, and writes nothing, when the
   * account already has a courier profile in this Market.
   */
  insert(market: MarketContext, courier: CourierState): Promise<boolean>;
  /**
   * Saves `courier` (version n + 1) over version n, with its new and changed vehicles and
   * documents. Throws `StaleAggregateError` when the stored version is no longer n.
   */
  update(market: MarketContext, courier: CourierState): Promise<void>;
  /**
   * A page of the Market's couriers in id order (UUIDv7, so oldest first), after `after`,
   * optionally of one standing.
   */
  list(
    market: MarketContext,
    query: {
      readonly status?: CourierStatus;
      readonly after?: Id<'Courier'>;
      readonly limit: number;
    },
  ): Promise<CourierState[]>;
  /**
   * A page of the Market's verified documents that expire before `before` (already expired
   * ones too), of couriers not offboarded, soonest first then by id, after the document `after`.
   */
  expiringDocuments(
    market: MarketContext,
    query: {
      readonly before: Temporal.Instant;
      readonly after?: Id<'CourierDocument'>;
      readonly limit: number;
    },
  ): Promise<ExpiringDocument[]>;
  /** Which of these file keys a document row of the Market names, in any tenant. */
  namedFileKeys(market: MarketContext, fileKeys: readonly string[]): Promise<Set<string>>;
  /**
   * Adds one to the version of the couriers of these accounts, changing nothing else: a change of
   * a courier's jobs then conflicts with a shift change read before it (handoff 31, Hassan M1).
   */
  touch(market: MarketContext, actorIds: readonly string[]): Promise<void>;
  /** The active couriers who are online in a service area, with their vehicles and documents. */
  findOnlineInArea(market: MarketContext, serviceAreaCode: string): Promise<CourierState[]>;
}
export const COURIER_REPOSITORY = Symbol('CourierRepository');

/** A verified document that runs out soon, with whose it is. */
export interface ExpiringDocument {
  readonly documentId: Id<'CourierDocument'>;
  readonly courierId: Id<'Courier'>;
  /** The courier's identity account id. */
  readonly accountId: string;
  /** The Market's code of the document. */
  readonly type: string;
  readonly expiresAt: Temporal.Instant;
}

/**
 * Fleet's view of the deliveries couriers carry (`CourierJob`), kept by the subscriber to
 * delivery's events. Runs inside the caller's unit of work, like {@link CourierRepository}.
 */
export interface CourierJobRepository {
  find(market: MarketContext, deliveryId: Id<'Delivery'>): Promise<CourierJob | undefined>;
  /**
   * Writes `job` over the stored one, which had `previousVersion` (undefined: none yet). Throws
   * `StaleAggregateError` when another event of the delivery was applied in between, so the
   * event is retried and reads the job again.
   */
  save(market: MarketContext, job: CourierJob, previousVersion: number | undefined): Promise<void>;
}
export const COURIER_JOB_REPOSITORY = Symbol('CourierJobRepository');

/** The fleet rules and service areas of the Markets this deployment hosts. */
export interface FleetRulesProvider {
  /** The rules of a hosted Market; the request's Market is always hosted. */
  get(marketId: MarketId): MarketFleetRules;
  /** Whether the Market has a service area with this code. */
  hasServiceArea(marketId: MarketId, code: string): boolean;
  /** What the courier app shows in the Market. */
  courierAppSettings(marketId: MarketId): CourierAppSettings;
}

/** The Market settings the courier app runs on (the app's `CourierSettings`). */
export interface CourierAppSettings {
  readonly marketId: MarketId;
  readonly locale: string;
  readonly currency: string;
  readonly distanceUnit: 'km' | 'mi';
  /** E.164. */
  readonly supportPhone: string;
  /** How long a courier has to accept an offer (dispatch's offer timeout). */
  readonly offerAcceptSeconds: number;
  readonly coldChain: {
    readonly chilled: { readonly maxCelsius: number };
    readonly frozen: { readonly maxCelsius: number };
  };
  // What onboarding asks of a new courier (package 38): where they may work, with what, and the
  // documents the Market requires.
  /** The Market's service areas that take deliveries. */
  readonly serviceAreas: readonly { readonly code: string }[];
  /** The vehicle types the Market offers, with the rate card's default capacity. */
  readonly vehicleClasses: readonly {
    readonly type: VehicleType;
    readonly maxWeightGrams: number;
    readonly maxVolumeLitres: number;
    readonly temperatures: readonly Temperature[];
  }[];
  readonly documents: readonly DocumentRequirement[];
  /** The document that proves a contractor's business registration, or null. */
  readonly businessIdDocumentType: string | null;
}
export const FLEET_RULES = Symbol('FleetRulesProvider');
