import type { MarketId } from '@mondapac-drive/shared-kernel';
import { normalisePostcode, type PostcodeInterval } from './postcode-entry';

export { normalisePostcode, type PostcodeInterval };

/** A ServiceArea as the delivery module reads it (marketplace ADR-0005 decision 7). */
export interface ServiceArea {
  readonly code: string;
  readonly deliveryEnabled: boolean;
}

export interface ServiceAreaDefinition extends ServiceArea {
  /** Digits-only postcodes and ranges. */
  readonly intervals: readonly PostcodeInterval[];
  /** Other postcodes, normalised (see `normalisePostcode`). */
  readonly exact: ReadonlySet<string>;
}

/**
 * Which ServiceArea a postcode falls in (ADR-0005 decision 7). Read-only and built once at
 * boot from `config/service-areas/`; an area does not own a time zone. There is no default:
 * a postcode no area lists, a Market with no areas and a Market this Region Stack does not
 * host all answer `undefined`, so a caller treats the address as outside every area.
 */
export class ServiceAreaDirectory {
  constructor(
    private readonly areasByMarket: ReadonlyMap<MarketId, readonly ServiceAreaDefinition[]>,
  ) {}

  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined {
    if (typeof postcode !== 'string') return undefined;
    const normalised = normalisePostcode(postcode);
    // Config is ASCII only; case folding must not turn other characters into a match (ß, ſ).
    if (normalised === '' || /[^\x21-\x7e]/u.test(normalised)) return undefined;
    const digits = /^\d{1,10}$/u.test(normalised) ? Number(normalised) : undefined;
    for (const area of this.areasByMarket.get(marketId) ?? []) {
      const found =
        area.exact.has(normalised) ||
        (digits !== undefined &&
          area.intervals.some(
            (interval) =>
              interval.length === normalised.length &&
              interval.low <= digits &&
              digits <= interval.high,
          ));
      if (found) {
        return {
          code: area.code,
          deliveryEnabled: area.deliveryEnabled,
        };
      }
    }
    return undefined;
  }

  /** Every area of a Market, for admin lists and filters. Empty for an unknown Market. */
  areasOf(marketId: MarketId): readonly ServiceArea[] {
    return (this.areasByMarket.get(marketId) ?? []).map(({ code, deliveryEnabled }) => ({
      code,
      deliveryEnabled,
    }));
  }
}
