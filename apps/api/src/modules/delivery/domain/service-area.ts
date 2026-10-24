/** An inclusive postcode range; a single postcode has from === to. */
export interface PostcodeRange {
  readonly from: string;
  readonly to: string;
}

/** A city a Market rolls out to, as in the marketplace's ServiceArea config. */
export interface ServiceArea {
  readonly code: string;
  readonly timezone: string;
  readonly postcodes: readonly PostcodeRange[];
  readonly deliveryEnabled: boolean;
}

export function parsePostcodeRange(entry: string): PostcodeRange {
  const parts = entry.split('-');
  const from = parts[0] ?? '';
  const to = parts[1] ?? from;
  if (parts.length > 2 || !from || from.length !== to.length || from > to) {
    throw new RangeError(`Invalid postcode range "${entry}"`);
  }
  return { from, to };
}

export function findServiceArea(
  areas: readonly ServiceArea[],
  postcode: string,
): ServiceArea | undefined {
  return areas.find((area) =>
    area.postcodes.some(
      (range) =>
        postcode.length === range.from.length && postcode >= range.from && postcode <= range.to,
    ),
  );
}
