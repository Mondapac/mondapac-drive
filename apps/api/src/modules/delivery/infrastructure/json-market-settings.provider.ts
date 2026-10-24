import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketId, type MarketId } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import type { MarketSettingsProvider } from '../application/ports.js';
import { DeliveryDomainError } from '../domain/errors.js';
import type { MarketDeliverySettings } from '../domain/market-settings.js';
import { TEMPERATURES } from '../domain/parcel.js';
import { parsePostcodeRange } from '../domain/service-area.js';
import { VEHICLE_TYPES } from '../domain/vehicle.js';

const minor = z.number().int().nonnegative();
const temperature = z.enum(TEMPERATURES);

const vehicleRate = z.strictObject({
  baseFee: minor,
  perKm: minor,
  maxDistanceMetres: z.number().int().positive(),
  maxWeightGrams: z.number().int().positive(),
  maxVolumeLitres: z.number().int().positive(),
  temperatures: z.array(temperature).min(1),
});

const marketFile = z.strictObject({
  code: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1),
  pricesIncludeTax: z.boolean(),
  taxRateBps: z.number().int().min(0).max(10_000),
  serviceAreas: z
    .array(
      z.strictObject({
        code: z.string().min(1),
        timezone: z.string().min(1),
        postcodes: z.array(z.string()).min(1),
        deliveryEnabled: z.boolean(),
      }),
    )
    .min(1),
  rateCard: z.strictObject({
    vehicles: z.partialRecord(z.enum(VEHICLE_TYPES), vehicleRate),
    coldChainSurcharge: z.strictObject({ ambient: minor, chilled: minor, frozen: minor }),
    scheduledDiscountBps: z.number().int().min(0).max(10_000),
  }),
  coldChain: z.strictObject({
    chilled: z.strictObject({ maxCelsius: z.number() }),
    frozen: z.strictObject({ maxCelsius: z.number() }),
  }),
  scheduling: z.strictObject({
    minLeadMinutes: z.number().int().nonnegative(),
    maxDaysAhead: z.number().int().positive(),
    minWindowMinutes: z.number().int().positive(),
  }),
});

/**
 * Loads `<CODE>.json` for each hosted Market from the first directory that has it, and fails at
 * start-up on any invalid file, so a bad rate card never reaches a quote.
 */
export class JsonMarketSettingsProvider implements MarketSettingsProvider {
  private readonly settings = new Map<string, MarketDeliverySettings>();

  constructor(hostedMarkets: readonly string[], directories: readonly string[]) {
    if (hostedMarkets.length === 0) throw new Error('HOSTED_MARKETS names no Market');
    for (const code of hostedMarkets) {
      const dir = directories.find((d) => existsSync(join(d, `${code}.json`)));
      if (!dir) throw new Error(`No market configuration file for ${code}`);
      this.settings.set(code, load(join(dir, `${code}.json`), code));
    }
  }

  get(id: MarketId): MarketDeliverySettings {
    const settings = this.settings.get(id);
    if (!settings) {
      throw new DeliveryDomainError('market.not-hosted', `Market ${id} is not served here`);
    }
    return settings;
  }
}

function load(path: string, code: string): MarketDeliverySettings {
  const parsed = marketFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid market configuration ${path}: ${z.prettifyError(parsed.error)}`);
  }
  const file = parsed.data;
  if (file.code !== code) throw new Error(`${path} declares code ${file.code}, expected ${code}`);
  if (Object.keys(file.rateCard.vehicles).length === 0) {
    throw new Error(`${path} offers no vehicle`);
  }
  return {
    ...file,
    marketId: marketId(file.code),
    serviceAreas: file.serviceAreas.map((area) => ({
      ...area,
      postcodes: area.postcodes.map(parsePostcodeRange),
    })),
  };
}
