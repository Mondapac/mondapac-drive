// The live map's configuration (Drive). Read by the page server and by `proxy.ts` (its tile
// origins join the Content-Security-Policy), so no `server-only` marker. A panel without
// PANEL_MAP_STYLE_URL has no base map: the live map page still lists couriers and exceptions
// around the Market's center. A Market without a center has no live couriers list.

export interface MapPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface MapConfig {
  /** A MapLibre style URL with the provider's key in it (the browser loads it); null: no base map. */
  readonly styleUrl: string | null;
  /** Origins the style's tiles, glyphs and sprites come from (CSP connect-src and img-src). */
  readonly origins: readonly string[];
  /** The first view of each Market the panel serves, by Market code; the map stream's center. */
  readonly centers: Readonly<Record<string, MapPoint>>;
  readonly zoom: number;
}

const MARKET_ID = /^[A-Z]{2}$/;
const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$|^localhost$/;

function parseOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}: '${raw}' is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name}: '${url.origin}' must use https`);
  // The origin goes into the CSP: a host the URL parser lets through with `;` or `*` in it would
  // add a directive or a wildcard (security review of the live map, L1).
  if (url.username !== '' || url.password !== '' || !HOST_NAME.test(url.hostname)) {
    throw new Error(`${name}: '${raw}' must be a plain https host name`);
  }
  return url.origin;
}

/** `AU:-27.4698,153.0251;ZZ:35.6812,139.7671`. Throws on anything malformed. */
export function parseMapCenters(raw: string | undefined): Readonly<Record<string, MapPoint>> {
  const centers: Record<string, MapPoint> = {};
  for (const entry of (raw ?? '').split(';')) {
    if (entry.trim() === '') continue;
    const match = /^([A-Z]{2}):(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(entry.trim());
    const lat = Number(match?.[2]);
    const lng = Number(match?.[3]);
    if (
      match === null ||
      !MARKET_ID.test(match[1] ?? '') ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      throw new Error(`PANEL_MAP_CENTERS: '${entry.trim()}' is not MARKET:lat,lng`);
    }
    centers[match[1] as string] = { lat, lng };
  }
  return centers;
}

/** The map configuration; throws on a malformed value, so start-up fails. */
export function parseMapConfig(env: Readonly<Record<string, string | undefined>>): MapConfig {
  const style = env['PANEL_MAP_STYLE_URL']?.trim() ?? '';
  const extra = (env['PANEL_MAP_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => parseOrigin(value, 'PANEL_MAP_ORIGINS'));
  const zoomText = env['PANEL_MAP_ZOOM']?.trim() ?? '';
  const zoom = zoomText === '' ? 11 : Number(zoomText);
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 18) {
    throw new Error('PANEL_MAP_ZOOM must be a number from 1 to 18');
  }
  return {
    styleUrl: style === '' ? null : style,
    origins:
      style === '' ? [] : [...new Set([parseOrigin(style, 'PANEL_MAP_STYLE_URL'), ...extra])],
    centers: parseMapCenters(env['PANEL_MAP_CENTERS']),
    zoom,
  };
}

let cached: MapConfig | undefined;

/** The map configuration of this process, read once. */
export function mapConfig(): MapConfig {
  cached ??= parseMapConfig(process.env);
  return cached;
}
