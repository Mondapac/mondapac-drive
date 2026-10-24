/** The browser families a session's device is named by; anything else is `other`. */
export const DEVICE_BROWSERS = [
  'edge',
  'opera',
  'samsung',
  'firefox',
  'chrome',
  'safari',
  'other',
] as const;
export type DeviceBrowser = (typeof DEVICE_BROWSERS)[number];

/** The operating systems a session's device is named by; anything else is `other`. */
export const DEVICE_SYSTEMS = [
  'windows',
  'macos',
  'ios',
  'android',
  'chromeos',
  'linux',
  'other',
] as const;
export type DeviceSystem = (typeof DEVICE_SYSTEMS)[number];

/**
 * The coarse device of a session (profile package 4, active sessions): `<browser>.<system>`,
 * both from the fixed lists above, e.g. `chrome.windows`. It is all a session keeps of the
 * client's User-Agent: never the raw header, a version or a model, so the column holds no free
 * text from the client and names no single device.
 */
export type DeviceCode = `${DeviceBrowser}.${DeviceSystem}`;

/** Longer headers are cut before matching: the families sit near the start. */
const MAX_USER_AGENT_LENGTH = 512;

/** First match wins: Edge and Opera also say Chrome, Chrome also says Safari. */
const BROWSER_RULES: readonly (readonly [RegExp, DeviceBrowser])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'edge'],
  [/\b(?:OPR|OPT|Opera)\//, 'opera'],
  [/\bSamsungBrowser\//, 'samsung'],
  [/\b(?:Firefox|FxiOS)\//, 'firefox'],
  [/\b(?:Chrome|Chromium|CriOS)\//, 'chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'safari'],
];

/** First match wins: Android says Linux, iOS says "like Mac OS X". */
const SYSTEM_RULES: readonly (readonly [RegExp, DeviceSystem])[] = [
  [/\bWindows\b/, 'windows'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'ios'],
  [/\bAndroid\b/, 'android'],
  [/\bCrOS\b/, 'chromeos'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macos'],
  [/\bLinux\b/, 'linux'],
];

/** The coarse device of a User-Agent header, or null when the request sent none. */
export function deviceOf(userAgent: string | undefined | null): DeviceCode | null {
  if (typeof userAgent !== 'string') return null;
  const text = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  if (text.trim() === '') return null;
  const browser = BROWSER_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'other';
  const system = SYSTEM_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'other';
  return `${browser}.${system}`;
}

/** A stored device code read back, or null when it is not one of the fixed pairs. */
export function parseDeviceCode(value: string | null): DeviceCode | null {
  if (value === null) return null;
  const [browser, system, extra] = value.split('.');
  if (
    extra !== undefined ||
    !(DEVICE_BROWSERS as readonly (string | undefined)[]).includes(browser) ||
    !(DEVICE_SYSTEMS as readonly (string | undefined)[]).includes(system)
  ) {
    return null;
  }
  return value as DeviceCode;
}
