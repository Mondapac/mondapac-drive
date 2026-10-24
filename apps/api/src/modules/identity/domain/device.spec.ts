import { deviceOf, parseDeviceCode } from './device';

// The coarse device of a session (profile package 4): a fixed browser and system code, never
// the raw header.

describe('deviceOf', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'chrome.windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'edge.windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      'safari.macos',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      'safari.ios',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      'chrome.ios',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'samsung.android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 'firefox.linux'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'chrome.chromeos',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/122.0.0.0',
      'opera.windows',
    ],
    ['curl/8.5.0', 'other.other'],
  ])('%s is %s', (userAgent, expected) => {
    expect(deviceOf(userAgent)).toBe(expected);
  });

  it('is null without a header', () => {
    expect(deviceOf(undefined)).toBeNull();
    expect(deviceOf(null)).toBeNull();
    expect(deviceOf('   ')).toBeNull();
  });

  it('keeps nothing of the header but the two codes', () => {
    const device = deviceOf('<script>alert(1)</script> Chrome/1 Windows evil.example');
    expect(device).toBe('chrome.windows');
  });

  it('reads only the start of a very long header', () => {
    expect(deviceOf(`${'x'.repeat(600)} Firefox/1 Windows`)).toBe('other.other');
  });
});

describe('parseDeviceCode', () => {
  it('reads back a stored pair', () => {
    expect(parseDeviceCode('chrome.windows')).toBe('chrome.windows');
    expect(parseDeviceCode(null)).toBeNull();
  });

  it.each(['chrome', 'chrome.windows.x', 'netscape.windows', 'chrome.beos', ''])(
    '%s is not a device',
    (value) => {
      expect(parseDeviceCode(value)).toBeNull();
    },
  );
});
