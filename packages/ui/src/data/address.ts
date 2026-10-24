// Street lines first, then locality, region and postcode on one line. This is the Australian and
// UK order; Markets that write the place differently (US, Japan) need the order from Market
// configuration (ADR-0002) before they launch. The Market decides which keys exist, so a key
// outside these lists is kept, after them, as its own line.
const STREET_KEYS = ['line1', 'line2', 'line3', 'street', 'address_line1', 'address_line2'];
const PLACE_KEYS = [
  'suburb',
  'locality',
  'city',
  'town',
  'state',
  'region',
  'province',
  'postcode',
  'postal_code',
  'postalCode',
  'zip',
];

/** A postal address as display lines ("149 Moggill Road" / "Taringa QLD 4068"). */
export function addressLines(address: Readonly<Record<string, string>> | null): string | null {
  if (address === null) return null;
  const value = (key: string) => address[key]?.trim() ?? '';
  const street = STREET_KEYS.map(value).filter((part) => part !== '');
  const place = PLACE_KEYS.map(value).filter((part) => part !== '');
  const known = new Set([...STREET_KEYS, ...PLACE_KEYS, 'country', 'country_code', 'countryCode']);
  const other = Object.entries(address)
    .filter(([key, part]) => !known.has(key) && part.trim() !== '')
    .map(([, part]) => part.trim());
  const lines = [...street, ...(place.length > 0 ? [place.join(' ')] : []), ...other];
  return lines.length === 0 ? null : lines.join('\n');
}
