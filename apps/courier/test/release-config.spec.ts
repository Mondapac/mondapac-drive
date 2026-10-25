import au from '../../../config/markets/AU.json';
import zz from '../../../test/fixtures/markets/ZZ.json';
import { BASE_APPLICATION_ID, resolveRelease, versionFrom } from '../release/release-config';

const configured = new Set([au.code, zz.code]);
const marketExists = (code: string) => configured.has(code);

describe.each([au.code, zz.code])('release config for Market %s', (marketId) => {
  const release = (env: Record<string, string>) => ({
    EXPO_PUBLIC_API_URL: 'https://api.example.test',
    EXPO_PUBLIC_MARKET_ID: marketId,
    ...env,
  });

  it('builds preview beside production, under its own identifier and name', () => {
    const preview = resolveRelease(release({ APP_VARIANT: 'preview' }), '0.1.0', marketExists);
    const production = resolveRelease(
      release({ APP_VARIANT: 'production' }),
      '0.1.0',
      marketExists,
    );
    expect(preview).toMatchObject({
      variant: 'preview',
      applicationId: `${BASE_APPLICATION_ID}.preview`,
      nameSuffix: ' (Preview)',
      marketId,
    });
    expect(production).toMatchObject({ applicationId: BASE_APPLICATION_ID, nameSuffix: '' });
  });

  it.each(['preview', 'production'])('refuses a %s build on the mock or plain http', (variant) => {
    expect(() =>
      resolveRelease(
        release({ APP_VARIANT: variant, EXPO_PUBLIC_API_MODE: 'mock' }),
        '0.1.0',
        marketExists,
      ),
    ).toThrow('cannot use the mock');
    expect(() =>
      resolveRelease(
        release({ APP_VARIANT: variant, EXPO_PUBLIC_API_URL: 'http://api.example.test' }),
        '0.1.0',
        marketExists,
      ),
    ).toThrow('https');
    expect(() =>
      resolveRelease(
        { APP_VARIANT: variant, EXPO_PUBLIC_MARKET_ID: marketId },
        '0.1.0',
        marketExists,
      ),
    ).toThrow('https');
  });

  it('takes the version from the release tag and the build number from CI', () => {
    expect(
      resolveRelease(
        release({
          APP_VARIANT: 'production',
          APP_VERSION: 'courier-v1.4.2',
          APP_BUILD_NUMBER: '57',
        }),
        '0.1.0',
        marketExists,
      ),
    ).toMatchObject({ version: '1.4.2', buildNumber: 57 });
  });
});

describe('release config', () => {
  it('lets a development build run on the mock, without a Market', () => {
    expect(resolveRelease({}, '0.1.0', marketExists)).toMatchObject({
      variant: 'development',
      version: '0.1.0',
      buildNumber: 1,
      applicationId: `${BASE_APPLICATION_ID}.development`,
      apiUrl: undefined,
      marketId: undefined,
    });
  });

  it('refuses a Market that has no configuration', () => {
    expect(() =>
      resolveRelease(
        {
          APP_VARIANT: 'production',
          EXPO_PUBLIC_API_URL: 'https://api.example.test',
          EXPO_PUBLIC_MARKET_ID: 'QQ',
        },
        '0.1.0',
        marketExists,
      ),
    ).toThrow('configured Market');
  });

  it('refuses an unknown variant and a bad build number', () => {
    expect(() => resolveRelease({ APP_VARIANT: 'staging' }, '0.1.0', marketExists)).toThrow(
      'APP_VARIANT',
    );
    for (const bad of ['0', '-3', '1.5', 'abc', '9999999999']) {
      expect(() => resolveRelease({ APP_BUILD_NUMBER: bad }, '0.1.0', marketExists)).toThrow(
        'APP_BUILD_NUMBER',
      );
    }
  });

  it.each([
    ['courier-v2.0.1', '2.0.1'],
    ['v3.1.0', '3.1.0'],
    ['1.0.0', '1.0.0'],
    ['', '0.1.0'],
  ])('reads the version from "%s"', (tag, version) => {
    expect(versionFrom(tag, '0.1.0')).toBe(version);
  });

  it.each(['courier-v1.2', 'v01.2.3', 'courier-v1.2.3-rc.1'])('refuses the tag "%s"', (tag) => {
    expect(() => versionFrom(tag, '0.1.0')).toThrow('MAJOR.MINOR.PATCH');
  });
});
