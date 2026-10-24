/** The API's device code, `<browser>.<system>`; anything else reads as an unknown device. */
const BROWSERS = ['edge', 'opera', 'samsung', 'firefox', 'chrome', 'safari', 'other'] as const;
const SYSTEMS = ['windows', 'macos', 'ios', 'android', 'chromeos', 'linux', 'other'] as const;

type Translate = (key: string, values?: Record<string, string>) => string;

/** "Chrome on Windows", from the `sessions` messages; never the raw code. */
export function deviceLabel(t: Translate, device: string | null): string {
  const [browser, system, extra] = (device ?? '').split('.');
  if (
    extra !== undefined ||
    !(BROWSERS as readonly (string | undefined)[]).includes(browser) ||
    !(SYSTEMS as readonly (string | undefined)[]).includes(system) ||
    (browser === 'other' && system === 'other')
  ) {
    return t('sessions.unknown-device');
  }
  return t('sessions.device', {
    browser: t(`sessions.browser.${browser}`),
    system: t(`sessions.system.${system}`),
  });
}
