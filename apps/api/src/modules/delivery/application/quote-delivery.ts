import { Inject, Injectable } from '@nestjs/common';
import type { GeoPoint, MarketId } from '@mondapac-drive/shared-kernel';
import { CLOCK, type Clock } from '../../../platform/clock/clock.js';
import { DeliveryDomainError } from '../domain/errors.js';
import type { MarketDeliverySettings } from '../domain/market-settings.js';
import type { Parcel } from '../domain/parcel.js';
import { priceDelivery, type DeliveryQuote } from '../domain/pricing.js';
import { assertWindowAllowed, type DeliveryMode, type DeliveryWindow } from '../domain/schedule.js';
import { findServiceArea, type ServiceArea } from '../domain/service-area.js';
import type { VehicleType } from '../domain/vehicle.js';
import {
  DISTANCE_PROVIDER,
  MARKET_SETTINGS,
  type DistanceProvider,
  type MarketSettingsProvider,
} from './ports.js';

export interface QuoteDeliveryInput {
  readonly marketId: MarketId;
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

  async execute(input: QuoteDeliveryInput): Promise<QuoteDeliveryResult> {
    const settings = this.markets.get(input.marketId);
    const serviceArea = this.servedArea(settings, input.pickup.postcode, 'pickup');
    const dropoffArea = this.servedArea(settings, input.dropoff.postcode, 'dropoff');
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
    return { quote, serviceArea, settings };
  }

  private servedArea(
    settings: MarketDeliverySettings,
    postcode: string,
    stop: 'pickup' | 'dropoff',
  ): ServiceArea {
    const area = findServiceArea(settings.serviceAreas, postcode);
    if (!area || !area.deliveryEnabled) {
      throw new DeliveryDomainError(
        'service-area.not-served',
        `We do not deliver ${stop === 'pickup' ? 'from' : 'to'} postcode ${postcode} yet`,
      );
    }
    return area;
  }
}
