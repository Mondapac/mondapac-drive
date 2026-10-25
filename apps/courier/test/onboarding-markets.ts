import au from '../../../config/markets/AU.json';
import auAreas from '../../../config/service-areas/AU.json';
import zz from '../../../test/fixtures/markets/ZZ.json';
import zzAreas from '../../../test/fixtures/service-areas/ZZ.json';
import { onboardingRules, type CourierSettings, type OnboardingRules } from '../src/api/schemas';
import { settingsOf } from './render';

interface MarketConfig {
  readonly delivery: {
    readonly rateCard: {
      readonly vehicles: Readonly<
        Record<
          string,
          { maxWeightGrams: number; maxVolumeLitres: number; temperatures: readonly string[] }
        >
      >;
    };
  };
  readonly fleet: {
    readonly documents: readonly object[];
    readonly businessIdDocumentType?: string;
  };
}

interface AreaConfig {
  readonly areas: readonly { code: string; deliveryEnabled: boolean }[];
}

/**
 * The onboarding rules fleet sends a courier of a Market (`GET /fleet/courier/me/settings`),
 * built from the repository's Market and service-area config as fleet builds them.
 */
export function onboardingRulesOf(market: MarketConfig, areas: AreaConfig): OnboardingRules {
  return onboardingRules.parse({
    serviceAreas: areas.areas
      .filter((area) => area.deliveryEnabled)
      .map((area) => ({ code: area.code })),
    vehicleClasses: Object.entries(market.delivery.rateCard.vehicles).map(([type, vehicle]) => ({
      type,
      maxWeightGrams: vehicle.maxWeightGrams,
      maxVolumeLitres: vehicle.maxVolumeLitres,
      temperatures: vehicle.temperatures,
    })),
    documents: market.fleet.documents,
    businessIdDocumentType: market.fleet.businessIdDocumentType ?? null,
  });
}

/** Onboarding is tested on the launch Market and on the synthetic ZZ Market. */
export const ONBOARDING_MARKETS: readonly {
  readonly settings: CourierSettings;
  readonly rules: OnboardingRules;
}[] = [
  { settings: settingsOf(au), rules: onboardingRulesOf(au, auAreas) },
  { settings: settingsOf(zz), rules: onboardingRulesOf(zz, zzAreas) },
];
