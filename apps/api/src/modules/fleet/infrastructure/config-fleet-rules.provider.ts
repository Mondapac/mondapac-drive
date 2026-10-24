import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { FleetRulesProvider } from '../application/ports';
import type { MarketFleetRules, VehicleClass } from '../domain/fleet-rules';
import { VEHICLE_TYPES, type VehicleType } from '../domain/vehicle';

/**
 * {@link FleetRulesProvider} over the platform's Market configuration: the `fleet` section of
 * `config/markets/<CODE>.json`, validated at start-up, the vehicle types of its delivery rate
 * card (their default capacity and temperatures), and the service areas of
 * `config/service-areas/<CODE>.json`.
 */
export class ConfigFleetRulesProvider implements FleetRulesProvider {
  readonly #rules = new Map<MarketId, MarketFleetRules>();

  constructor(
    private readonly markets: MarketRegistry,
    private readonly areas: ServiceAreaDirectory,
  ) {}

  get(marketId: MarketId): MarketFleetRules {
    const cached = this.#rules.get(marketId);
    if (cached !== undefined) return cached;
    const market = this.markets.get(marketId);
    const vehicleClasses: Partial<Record<VehicleType, VehicleClass>> = {};
    for (const type of VEHICLE_TYPES) {
      const rate = market.delivery.rateCard.vehicles[type];
      if (rate === undefined) continue;
      vehicleClasses[type] = Object.freeze({
        maxWeightGrams: rate.maxWeightGrams,
        maxVolumeLitres: rate.maxVolumeLitres,
        temperatures: Object.freeze([...rate.temperatures]),
      });
    }
    const { businessIdDocumentType } = market.fleet;
    const rules: MarketFleetRules = Object.freeze({
      marketId,
      vehicleClasses: Object.freeze(vehicleClasses),
      ...(businessIdDocumentType === undefined ? {} : { businessIdDocumentType }),
      documents: market.fleet.documents.map((document) =>
        Object.freeze({
          type: document.type,
          ...(document.employmentTypes ? { employmentTypes: document.employmentTypes } : {}),
          ...(document.vehicleTypes ? { vehicleTypes: document.vehicleTypes } : {}),
          coldChainOnly: document.coldChainOnly,
          perVehicle: document.perVehicle,
          expires: document.expires,
        }),
      ),
    });
    this.#rules.set(marketId, rules);
    return rules;
  }

  hasServiceArea(marketId: MarketId, code: string): boolean {
    return this.areas.areasOf(marketId).some((area) => area.code === code);
  }
}
