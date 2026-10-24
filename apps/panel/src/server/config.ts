// Server-side configuration of the admin panel (ADR-0034 decision 3). Nothing here has a
// default Market: a host that is not listed is unknown and answers 404 (ADR-0020 decision 3).
import 'server-only';
import { parseClientAddressKey, type ClientAddressKey } from '@mondapac-drive/panel-server/signer';

export interface PanelHost {
  /** `scheme://host[:port]`, exactly what a browser sends in `Origin`. */
  readonly origin: string;
  /** `host[:port]`, lower case, as a browser sends in `Host`. */
  readonly host: string;
  readonly marketId: string;
}

export interface PanelConfig {
  readonly apiBaseUrl: string;
  readonly hosts: readonly PanelHost[];
  readonly passwordMinLength: number;
  readonly passwordMaxLength: number;
  /** Shown beside the brand, for example "Australia" (a Market display name). */
  readonly marketName: string;
  /** The Market's language and formats as a canonical BCP 47 tag, for example "en-AU". */
  readonly locale: string;
  readonly supportEmail: string;
  /** This panel's key for the signed client address (ADR-0037); null when it is not set. */
  readonly clientAddressKey: ClientAddressKey | null;
}

const MARKET_ID = /^[A-Z]{2}$/;

/** Parses `origin=MARKET,origin=MARKET`. Throws on anything malformed, so start-up fails. */
export function parsePanelHosts(raw: string | undefined): readonly PanelHost[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'PANEL_HOSTS is required: origin=MARKET pairs, for example http://admin.localhost:3002=AU',
    );
  }
  const hosts: PanelHost[] = [];
  for (const entry of raw.split(',')) {
    const separator = entry.lastIndexOf('=');
    if (separator < 1) throw new Error(`PANEL_HOSTS: '${entry.trim()}' is not origin=MARKET`);
    const originText = entry.slice(0, separator).trim();
    const marketId = entry.slice(separator + 1).trim();
    let url: URL;
    try {
      url = new URL(originText);
    } catch {
      throw new Error(`PANEL_HOSTS: '${originText}' is not an origin`);
    }
    if (url.origin !== originText || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new Error(`PANEL_HOSTS: '${originText}' must be scheme://host[:port] with no path`);
    }
    if (!MARKET_ID.test(marketId)) {
      throw new Error(`PANEL_HOSTS: '${marketId}' is not a Market code`);
    }
    if (hosts.some((existing) => existing.host === url.host)) {
      throw new Error(`PANEL_HOSTS: host '${url.host}' is listed twice`);
    }
    hosts.push({ origin: url.origin, host: url.host, marketId });
  }
  return hosts;
}

function parseApiBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw new Error('API_BASE_URL is required');
  const url = new URL(raw);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('API_BASE_URL must be an origin with no path');
  }
  return url.origin;
}

/** `15-128`: the Market's password length rule, which the panel shows as help text. */
function parsePasswordRules(raw: string | undefined): readonly [number, number] {
  const match = /^(\d{1,3})-(\d{1,3})$/.exec(raw ?? '');
  const min = Number(match?.[1]);
  const max = Number(match?.[2]);
  if (match === null || min < 1 || max < min) {
    throw new Error(
      'PANEL_PASSWORD_LENGTH is required, for example 15-128 (the Market password rule)',
    );
  }
  return [min, max];
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

/** The Market locale as a canonical BCP 47 tag ("en-AU"). Throws on anything else, so start-up fails. */
export function parseLocale(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new Error('PANEL_LOCALE is required, for example en-AU (the Market locale)');
  }
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(value)[0];
  } catch {
    canonical = undefined;
  }
  if (canonical !== value) {
    throw new Error(`PANEL_LOCALE: '${value}' is not a canonical BCP 47 tag (for example en-AU)`);
  }
  return canonical;
}

export function parsePanelConfig(env: Readonly<Record<string, string | undefined>>): PanelConfig {
  const [passwordMinLength, passwordMaxLength] = parsePasswordRules(env['PANEL_PASSWORD_LENGTH']);
  return {
    apiBaseUrl: parseApiBaseUrl(env['API_BASE_URL']),
    hosts: parsePanelHosts(env['PANEL_HOSTS']),
    passwordMinLength,
    passwordMaxLength,
    marketName: required(env, 'PANEL_MARKET_NAME'),
    locale: parseLocale(env['PANEL_LOCALE']),
    supportEmail: required(env, 'PANEL_SUPPORT_EMAIL'),
    clientAddressKey: parseClientAddressKey(env),
  };
}

/**
 * Start-up tripwire (ADR-0034 decision 3, ADR-0037): without the signed client address every user
 * shares one per-origin throttle bucket at the API. A host that is not `*.localhost` therefore
 * needs a signing key (BFF_CLIENT_ADDRESS_KEY_ID and BFF_CLIENT_ADDRESS_SECRET); the signer
 * itself refuses a request that did not come through `server.mjs`.
 */
export function assertClientAddressForwarding(config: PanelConfig): void {
  const local = config.hosts.every((host) => /^[a-z0-9-]+\.localhost(:\d+)?$/.test(host.host));
  if (local || config.clientAddressKey !== null) return;
  throw new Error(
    'A panel on a real host must sign the client address: set BFF_CLIENT_ADDRESS_KEY_ID and ' +
      'BFF_CLIENT_ADDRESS_SECRET (ADR-0037).',
  );
}

let cached: PanelConfig | undefined;

/** The configuration of this process, read once; throws when it is missing or malformed. */
export function panelConfig(): PanelConfig {
  if (cached === undefined) {
    const config = parsePanelConfig(process.env);
    assertClientAddressForwarding(config);
    cached = config;
  }
  return cached;
}
