import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type Clock,
  type GeoPoint,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { DeliveryDomainError } from '../domain/errors';
import type { MarketDeliverySettings } from '../domain/market-settings';
import type { Parcel } from '../domain/parcel';
import { priceDelivery, type DeliveryQuote } from '../domain/pricing';
import { assertWindowAllowed, type DeliveryMode, type DeliveryWindow } from '../domain/schedule';
import type { ServiceArea } from '../domain/service-area';
import type { VehicleType } from '../domain/vehicle';
import { refusingBrokenRules, type DeliveryFailure } from './failure';
import {
  DISTANCE_PROVIDER,
  MARKET_SETTINGS,
  type DistanceProvider,
  type MarketSettingsProvider,
} from './ports';

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

/** Prices a delivery without booking it. CreateDelivery runs the same checks again. */
@Injectable()
export class QuoteDelivery {
  constructor(
    @Inject(MARKET_SETTINGS) private readonly markets: MarketSettingsProvider,
    @Inject(DISTANCE_PROVIDER) private readonly distances: DistanceProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(
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
