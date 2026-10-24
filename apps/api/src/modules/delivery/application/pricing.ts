import {
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
import type { DistanceProvider, MarketSettingsProvider } from './ports';

export interface QuoteDeliveryInput {
  readonly pickup: { readonly postcode: string; readonly point: GeoPoint };
  readonly dropoff: { readonly postcode: string; readonly point: GeoPoint };
  readonly parcel: Parcel;
  readonly mode: DeliveryMode;
  readonly window?: DeliveryWindow;
  readonly vehicle?: VehicleType;
}

export interface QuoteDeliveryResult {
  readonly quote: DeliveryQuote;
  readonly serviceArea: ServiceArea;
  readonly settings: MarketDeliverySettings;
}

/** The ports {@link DeliveryPricing} reads. */
export interface DeliveryPricingDependencies {
  readonly markets: MarketSettingsProvider;
  readonly distances: DistanceProvider;
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
  private readonly clock: Clock;

  constructor(deps: DeliveryPricingDependencies) {
    this.markets = deps.markets;
    this.distances = deps.distances;
    this.clock = deps.clock;
  }

  price(
    market: MarketContext,
    input: QuoteDeliveryInput,
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

      const distanceMetres = await this.distances.roadDistanceMetres(
        input.pickup.point,
        input.dropoff.point,
      );
      const quote = priceDelivery(settings, {
        parcel: input.parcel,
        distanceMetres,
        mode: input.mode,
        vehicle: input.vehicle,
      });
      return ok({ quote, serviceArea, settings });
    });
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
