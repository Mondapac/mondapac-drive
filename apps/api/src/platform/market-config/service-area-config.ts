import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import {
  InvalidPostcodeEntryError,
  parsePostcodeEntries,
  postcodesClash,
  type ParsedPostcodes,
} from './postcode-entry';
import { ServiceAreaDirectory, type ServiceAreaDefinition } from './service-area-directory';

/** Codes from configuration are text, never a closed list (sellers data design S8). */
const AREA_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const areaSchema = z.strictObject({
  code: z.string().regex(AREA_CODE, 'must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  /** Exact postcodes ("4000", "SW1A 1AA") or digit ranges ("4000-4179", same length). */
  postcodes: z.array(z.string()).min(1),
  deliveryEnabled: z.boolean(),
});

const fileSchema = z.strictObject({
  market: z.string(),
  areas: z.array(areaSchema),
});

export class InvalidServiceAreaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServiceAreaConfigError';
  }
}

function parsePostcodes(entries: readonly string[], where: string): ParsedPostcodes {
  try {
    return parsePostcodeEntries(entries);
  } catch (error) {
    if (error instanceof InvalidPostcodeEntryError) {
      throw new InvalidServiceAreaConfigError(`${where}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Reads `<MARKET>.json` for each hosted market from the given directories and builds the
 * directory. Throws on a missing or invalid file, a duplicate code, or a postcode that two
 * areas both claim, so a Region Stack never starts with an ambiguous map.
 */
export function loadServiceAreas(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
): ServiceAreaDirectory {
  const files = new Map<string, string>();
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      throw new InvalidServiceAreaConfigError(`Service-area directory ${directory} cannot be read`);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidServiceAreaConfigError(`Market "${code}" has service areas twice`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const byMarket = new Map<MarketId, readonly ServiceAreaDefinition[]>();
  for (const marketId of hostedMarkets) {
    const file = files.get(marketId);
    if (file === undefined) {
      throw new InvalidServiceAreaConfigError(
        `Hosted market "${marketId}" has no service-area file (${marketId}.json)`,
      );
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new InvalidServiceAreaConfigError(`${file} cannot be read`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new InvalidServiceAreaConfigError(`${file} is not valid JSON`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
        .join('; ');
      throw new InvalidServiceAreaConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.market !== marketId) {
      throw new InvalidServiceAreaConfigError(
        `${file} declares market "${parsed.data.market}"; it must match the file name`,
      );
    }

    const areas: ServiceAreaDefinition[] = [];
    for (const area of parsed.data.areas) {
      const where = `${file}: area "${area.code}"`;
      if (areas.some((other) => other.code === area.code)) {
        throw new InvalidServiceAreaConfigError(`${where} is listed twice`);
      }
      const postcodes = parsePostcodes(area.postcodes, where);
      for (const other of areas) {
        if (postcodesClash(postcodes, other)) {
          throw new InvalidServiceAreaConfigError(
            `${where} shares a postcode with "${other.code}"`,
          );
        }
      }
      areas.push(
        Object.freeze({
          code: area.code,
          deliveryEnabled: area.deliveryEnabled,
          intervals: Object.freeze(postcodes.intervals),
          exact: postcodes.exact,
        }),
      );
    }
    byMarket.set(marketId, Object.freeze(areas));
  }
  return new ServiceAreaDirectory(byMarket);
}
