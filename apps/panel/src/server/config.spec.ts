import { describe, expect, it } from 'vitest';
import { assertClientAddressForwarding, parsePanelConfig, parsePanelHosts } from './config.ts';

describe('parsePanelHosts', () => {
  it('parses origin=MARKET pairs', () => {
    expect(parsePanelHosts('http://admin.localhost:3002=AU, https://sell.example.nz=NZ')).toEqual([
      { origin: 'http://admin.localhost:3002', host: 'admin.localhost:3002', marketId: 'AU' },
      { origin: 'https://sell.example.nz', host: 'sell.example.nz', marketId: 'NZ' },
    ]);
  });

  it.each([
    ['', 'required'],
    ['admin.localhost=AU', 'not an origin'],
    ['http://a.test/path=AU', 'no path'],
    ['http://a.test=au', 'Market code'],
    ['http://a.test', 'origin=MARKET'],
    ['http://a.test=AU,http://a.test=NZ', 'twice'],
  ])('rejects %j', (raw, message) => {
    expect(() => parsePanelHosts(raw)).toThrow(message);
  });
});

describe('parsePanelConfig', () => {
  const env = {
    API_BASE_URL: 'http://localhost:3000',
    PANEL_HOSTS: 'http://admin.localhost:3002=AU',
    PANEL_PASSWORD_LENGTH: '15-128',
    PANEL_MARKET_NAME: 'Australia',
    PANEL_LOCALE: 'en-AU',
    PANEL_SUPPORT_EMAIL: 'support@example.com',
  };

  it('reads every setting', () => {
    const config = parsePanelConfig(env);
    expect(config.passwordMinLength).toBe(15);
    expect(config.passwordMaxLength).toBe(128);
    expect(config.marketName).toBe('Australia');
    expect(config.locale).toBe('en-AU');
  });

  it.each([
    'API_BASE_URL',
    'PANEL_HOSTS',
    'PANEL_PASSWORD_LENGTH',
    'PANEL_MARKET_NAME',
    'PANEL_LOCALE',
  ])('fails start-up without %s', (name) => {
    expect(() => parsePanelConfig({ ...env, [name]: undefined })).toThrow();
  });
});

describe('PANEL_LOCALE', () => {
  const env = {
    API_BASE_URL: 'http://localhost:3000',
    PANEL_HOSTS: 'http://admin.localhost:3002=MY',
    PANEL_PASSWORD_LENGTH: '15-128',
    PANEL_MARKET_NAME: 'Malaysia',
    PANEL_SUPPORT_EMAIL: 'support@example.com',
  };

  it.each(['en-AU', 'ms-MY', 'en-NZ', 'zh-Hant-TW'])('accepts the canonical tag %s', (tag) => {
    expect(parsePanelConfig({ ...env, PANEL_LOCALE: tag }).locale).toBe(tag);
  });

  it.each([undefined, '', '   '])('requires a value, not %j', (value) => {
    expect(() => parsePanelConfig({ ...env, PANEL_LOCALE: value })).toThrow('PANEL_LOCALE');
  });

  it.each(['en_AU', 'en-au', 'en-AU-', 'x'])('rejects %j', (value) => {
    expect(() => parsePanelConfig({ ...env, PANEL_LOCALE: value })).toThrow('PANEL_LOCALE');
  });
});

describe('assertClientAddressForwarding', () => {
  const base = {
    API_BASE_URL: 'http://localhost:3000',
    PANEL_PASSWORD_LENGTH: '15-128',
    PANEL_MARKET_NAME: 'Australia',
    PANEL_LOCALE: 'en-AU',
    PANEL_SUPPORT_EMAIL: 'support@example.com',
  };
  const configFor = (hosts: string) => parsePanelConfig({ ...base, PANEL_HOSTS: hosts });

  it('refuses a real host without a signing key, whatever NODE_ENV is', () => {
    expect(() => assertClientAddressForwarding(configFor('https://sell.example.com=AU'))).toThrow(
      'must sign the client address',
    );
  });

  it('allows a real host that has a signing key', () => {
    const config = parsePanelConfig({
      ...base,
      PANEL_HOSTS: 'https://sell.example.com=AU',
      BFF_CLIENT_ADDRESS_KEY_ID: 'panel',
      BFF_CLIENT_ADDRESS_SECRET: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    });
    expect(() => assertClientAddressForwarding(config)).not.toThrow();
  });

  it('allows *.localhost hosts only', () => {
    expect(() =>
      assertClientAddressForwarding(configFor('http://admin.localhost:3002=AU')),
    ).not.toThrow();
    expect(() =>
      assertClientAddressForwarding(
        configFor('http://admin.localhost:3002=AU,https://sell.example.com=NZ'),
      ),
    ).toThrow();
    expect(() => assertClientAddressForwarding(configFor('http://localhost:3002=AU'))).toThrow();
  });
});
