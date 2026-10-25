import {
  err,
  ok,
  type Clock,
  type GeoPoint,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { DeliveryDomainError } from '../domain/errors';
import type { MarketDeliverySettings } from '../domain/market-settings';
import type { Parcel } from '../domain/parcel';
import { priceDelivery, type DeliveryQuote } from '../domain/pricing';
import { assertWindowAllowed, type DeliveryMode, type DeliveryWindow } from '../domain/schedule';
import type { ServiceArea } from '../domain/service-area';
import type { VehicleType } from '../domain/vehicle';
import { refusingBrokenRules, type DeliveryFailure } from './failure';
import type { DistanceProvider, Geocoder, LocatedStop, MarketSettingsProvider } from './ports';

/** A stop as a request gives it: coordinates, or an address to geocode, or both. */
export interface StopLocation {
  readonly postcode: string;
  readonly point?: GeoPoint;
  readonly address?: string;
}

/** The vehicle the road distance is measured for when the request names none. */
const DEFAULT_ROUTING_VEHICLE: VehicleType = 'car';

export interface QuoteDeliveryInput {
  readonly pickup: StopLocation;
  readonly dropoff: StopLocation;
  readonly parcel: Parcel;
  readonly mode: DeliveryMode;
  readonly window?: DeliveryWindow;
  readonly vehicle?: VehicleType;
}

export interface QuoteDeliveryResult {
  readonly quote: DeliveryQuote;
  readonly serviceArea: ServiceArea;
  readonly settings: MarketDeliverySettings;
  /** The stops' points: as given, or geocoded from the address. */
  readonly pickupPoint: GeoPoint;
  readonly dropoffPoint: GeoPoint;
  /** The stops' suburbs, when they were geocoded from an address the geocoder found. */
  readonly pickupSuburb?: string;
  readonly dropoffSuburb?: string;
}

/** The ports {@link DeliveryPricing} reads. */
export interface DeliveryPricingDependencies {
  readonly markets: MarketSettingsProvider;
  readonly distances: DistanceProvider;
  readonly geocoder: Geocoder;
  readonly clock: Clock;
}

/**
 * Prices a delivery: the service area of both stops, the schedule window, the road distance and
 * the Market's tariff. Not a use case: the quote and the booking use cases call it behind their
 * own gates, and a booking runs the same checks again.
 */
export class DeliveryPricing {
  private readonly markets: MarketSettingsProvider;
  private readonly distances: DistanceProvider;
  private readonly geocoder: Geocoder;
  private readonly clock: Clock;

  constructor(deps: DeliveryPricingDependencies) {
    this.markets = deps.markets;
    this.distances = deps.distances;
    this.geocoder = deps.geocoder;
    this.clock = deps.clock;
  }

  /** `merchantId` is the asking merchant's, which scopes its geocoded addresses. */
  price(
    market: MarketContext,
    input: QuoteDeliveryInput,
    merchantId: string | null = null,
  ): Promise<Result<QuoteDeliveryResult, DeliveryFailure>> {
    return refusingBrokenRules(async () => {
      const settings = this.markets.get(market.marketId);
      const serviceArea = this.servedArea(market, input.pickup.postcode, 'pickup');
      const dropoffArea = this.servedArea(market, input.dropoff.postcode, 'dropoff');
      if (dropoffArea.code !== serviceArea.code) {
        throw new DeliveryDomainError(
          'service-area.crosses-areas',
          'Pickup and drop-off must be in the same service area',
        );
      }

      if (input.mode === 'scheduled') {
        if (!input.window) {
          throw new DeliveryDomainError(
            'schedule.window-required',
            'A scheduled delivery needs a window',
          );
        }
        assertWindowAllowed(input.window, this.clock.now(), settings.scheduling);
      } else if (input.window) {
        throw new DeliveryDomainError(
          'schedule.window-not-allowed',
          'An on-demand delivery has no window',
        );
      }

      // Both stops are located at once: a booking without coordinates waits for one geocoding
      // round trip, not two (the marketplace expects an answer within 2 s; handoff 09b).
      const [pickup, dropoff] = await Promise.all([
        this.locate(market, input.pickup, 'pickup', merchantId),
        this.locate(market, input.dropoff, 'dropoff', merchantId),
      ]);
      if ('code' in pickup) return err(pickup);
      if ('code' in dropoff) return err(dropoff);
      const pickupPoint = pickup.point;
      const dropoffPoint = dropoff.point;
      const distance = await this.distances.distance(
        market,
        pickupPoint,
        dropoffPoint,
        input.vehicle ?? DEFAULT_ROUTING_VEHICLE,
      );
      const quote = priceDelivery(settings, {
        parcel: input.parcel,
        distanceMetres: distance.metres,
        distanceEstimated: distance.estimated,
        mode: input.mode,
        vehicle: input.vehicle,
      });
      return ok({
        quote,
        serviceArea,
        settings,
        pickupPoint,
        dropoffPoint,
        ...(pickup.suburb === undefined ? {} : { pickupSuburb: pickup.suburb }),
        ...(dropoff.suburb === undefined ? {} : { dropoffSuburb: dropoff.suburb }),
      });
    });
  }

  /** The stop's point, geocoded from its address and postcode when the request gives none. */
  private async locate(
    market: MarketContext,
    stop: StopLocation,
    which: 'pickup' | 'dropoff',
    merchantId: string | null,
  ): Promise<LocatedStop | DeliveryFailure> {
    if (stop.point !== undefined) return { point: stop.point };
    if (stop.address === undefined) {
      return {
        code: 'address.point-required',
        message: `The ${which} needs a point or an address`,
      };
    }
    const located = await this.geocoder.locate(market, stop.address, stop.postcode, {
      merchantId,
    });
    if (located === 'not-found') {
      return { code: 'address.not-found', message: `The ${which} address could not be found` };
    }
    if (located === 'unavailable') {
      return {
        code: 'address.geocoding-unavailable',
        message: `The ${which} address cannot be located now; send its coordinates or retry`,
      };
    }
    return located;
  }

  private servedArea(
    market: MarketContext,
    postcode: string,
    stop: 'pickup' | 'dropoff',
  ): ServiceArea {
    const area = this.markets.areaFor(market.marketId, postcode);
    if (!area || !area.deliveryEnabled) {
      throw new DeliveryDomainError(
        'service-area.not-served',
        `We do not deliver ${stop === 'pickup' ? 'from' : 'to'} postcode ${postcode} yet`,
      );
    }
    return area;
  }
}
