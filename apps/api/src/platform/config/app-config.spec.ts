import path from 'node:path';
import { InvalidConfigError, loadAppConfig as load } from './app-config';

const DATABASE_URL = 'postgresql://user:secret@localhost:5432/db';

/** Loads config with a valid DATABASE_URL and APP_ROLE unless the test overrides them. */
function loadAppConfig(env: Record<string, string | undefined>) {
  return load({ DATABASE_URL, APP_ROLE: 'api', ...env });
}

describe('loadAppConfig', () => {
  it('applies defaults and parses the hosted markets list', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'AU, ZZ' });

    expect(config).toEqual({
      appRole: 'api',
      nodeEnv: 'development',
      nodeEnvExplicit: false,
      port: 3100,
      logLevel: 'info',
      hostedMarkets: ['AU', 'ZZ'],
      apiDocsEnabled: false,
      marketConfigDirs: [expect.stringMatching(/config[\\/]markets$/)],
      serviceAreaConfigDirs: [expect.stringMatching(/config[\\/]service-areas$/)],
      databaseUrl: DATABASE_URL,
      databasePoolMax: 10,
      mailCatcherUrl: null,
      objectStoreDir: null,
      clientAddressTrust: null,
      redisUrl: null,
    });
  });

  it('requires TLS to Redis in production, and never prints the URL', () => {
    const plain = {
      HOSTED_MARKETS: 'AU',
      NODE_ENV: 'production',
      REDIS_URL: 'redis://:pw1@cache:6379',
    };
    expect(() => loadAppConfig(plain)).toThrow(/REDIS_URL: must be a rediss:\/\/ \(TLS\) URL/);
    try {
      loadAppConfig(plain);
    } catch (error) {
      expect(String(error)).not.toContain('pw1');
    }
    expect(() => loadAppConfig({ ...plain, REDIS_URL: 'REDIS://:pw1@cache:6379' })).toThrow(
      /REDIS_URL: must be a rediss:\/\/ \(TLS\) URL/,
    );
    expect(loadAppConfig({ ...plain, REDIS_URL: 'rediss://:pw1@cache:6379' }).redisUrl).toBe(
      'rediss://:pw1@cache:6379',
    );
    expect(loadAppConfig({ ...plain, NODE_ENV: 'development' }).redisUrl).toBe(
      'redis://:pw1@cache:6379',
    );
  });

  it('takes Redis from REDIS_URL and refuses another scheme without echoing it', () => {
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU', REDIS_URL: 'redis://localhost:6380' }).redisUrl,
    ).toBe('redis://localhost:6380');
    expect(() =>
      loadAppConfig({ HOSTED_MARKETS: 'AU', REDIS_URL: 'http://user:s3cret@cache:6379' }),
    ).toThrow(/REDIS_URL: must be a redis:\/\/ or rediss:\/\/ URL/);
    try {
      loadAppConfig({ HOSTED_MARKETS: 'AU', REDIS_URL: 'http://user:s3cret@cache:6379' });
    } catch (error) {
      expect(String(error)).not.toContain('s3cret');
    }
  });

  describe('the BFF client address (ADR-0037)', () => {
    const SECRET = Buffer.alloc(32, 7).toString('base64');

    it.each([
      ['unset', {}],
      ['empty', { TRUSTED_BFF_CIDRS: '', CLIENT_ADDRESS_KEYS: '' }],
      ['blank', { TRUSTED_BFF_CIDRS: ' ', CLIENT_ADDRESS_KEYS: '  ' }],
    ])('is off when both variables are %s', (_label, env) => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', ...env }).clientAddressTrust).toBeNull();
    });

    it('parses the networks and the keys', () => {
      const trust = loadAppConfig({
        HOSTED_MARKETS: 'AU',
        TRUSTED_BFF_CIDRS: '10.20.0.0/16',
        CLIENT_ADDRESS_KEYS: `panel:10.20.1.0/24:${SECRET}`,
      }).clientAddressTrust;

      expect(trust?.bffCidrs.map((cidr) => cidr.text)).toEqual(['10.20.0.0/16']);
      expect([...(trust?.keys.keys() ?? [])]).toEqual(['panel']);
    });

    it('refuses to start on a bad setting and never prints the secret', () => {
      let error: unknown;
      try {
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          TRUSTED_BFF_CIDRS: '10.20.0.0/16',
          CLIENT_ADDRESS_KEYS: `panel:10.20.1.0/24:${SECRET};panel:10.20.1.0/24:${SECRET}`,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InvalidConfigError);
      const message = (error as InvalidConfigError).message;
      expect(message).toMatch(/CLIENT_ADDRESS_KEYS key "panel": the keyId is listed twice/);
      expect(message).not.toContain(SECRET);
    });
  });

  it('takes the local mail catcher from MAIL_CATCHER_URL (identity design 9)', () => {
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU', MAIL_CATCHER_URL: 'http://localhost:8025' })
        .mailCatcherUrl,
    ).toBe('http://localhost:8025');
  });

  it.each(['localhost:8025', 'ftp://localhost', 'not a url', ''])(
    'rejects MAIL_CATCHER_URL=%p',
    (value) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', MAIL_CATCHER_URL: value })).toThrow(
        /MAIL_CATCHER_URL/,
      );
    },
  );

  it('records whether NODE_ENV was set or defaulted (M2)', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' })).toMatchObject({
      nodeEnv: 'development',
      nodeEnvExplicit: true,
    });
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU' })).toMatchObject({
      nodeEnv: 'development',
      nodeEnvExplicit: false,
    });
  });

  it.each(['api', 'worker'] as const)('takes the process role %s from APP_ROLE', (role) => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', APP_ROLE: role }).appRole).toBe(role);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unknown', 'scheduler'],
    ['in upper case', 'WORKER'],
  ])(
    'refuses an APP_ROLE that is %s: there is no default (platform persistence 8, PA7)',
    (_case, value) => {
      expect.assertions(2);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', APP_ROLE: value });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as InvalidConfigError).issues).toEqual([
          'APP_ROLE: APP_ROLE is required and must be "api" or "worker"; there is no default',
        ]);
      }
    },
  );

  it('takes the pool maximum from DATABASE_POOL_MAX (platform persistence design 3.1 row 8)', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_POOL_MAX: '25' }).databasePoolMax).toBe(
      25,
    );
  });

  it.each(['0', '101', '2.5', 'many', ''])('rejects DATABASE_POOL_MAX=%p', (value) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_POOL_MAX: value })).toThrow(
      /DATABASE_POOL_MAX/,
    );
  });

  it('serves API docs only when explicitly enabled', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', API_DOCS_ENABLED: 'true' }).apiDocsEnabled).toBe(
      true,
    );
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' }).apiDocsEnabled).toBe(
      false,
    );
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', API_DOCS_ENABLED: 'yes' })).toThrow(
      /API_DOCS_ENABLED/,
    );
  });

  it('takes the market configuration directory from MARKET_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', MARKET_CONFIG_DIR: '/etc/markets' });

    expect(config.marketConfigDirs).toEqual([path.resolve('/etc/markets')]);
  });

  it('takes the service-area directory from SERVICE_AREA_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', SERVICE_AREA_CONFIG_DIR: '/etc/areas' });

    expect(config.serviceAreaConfigDirs).toEqual([path.resolve('/etc/areas')]);
  });

  it('accepts a single hosted market, whichever market it is', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).hostedMarkets).toEqual(['AU']);
    expect(loadAppConfig({ HOSTED_MARKETS: 'ZZ' }).hostedMarkets).toEqual(['ZZ']);
  });

  it('refuses to start without HOSTED_MARKETS instead of assuming a default market', () => {
    expect(() => loadAppConfig({})).toThrow(InvalidConfigError);
    expect(() => loadAppConfig({})).toThrow(/HOSTED_MARKETS/);
  });

  it.each(['', ' , ', 'au', 'AU,AU', 'AUSTRALIA1', 'A'])('rejects HOSTED_MARKETS=%p', (value) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: value })).toThrow(InvalidConfigError);
  });

  it.each(['0', '70000', 'abc', '80.5'])('rejects PORT=%p', (port) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', PORT: port })).toThrow(/PORT/);
  });

  it('refuses a worker that would drop info lines, the audit anchors among them', () => {
    for (const level of ['fatal', 'error', 'warn', 'silent']) {
      expect(() =>
        loadAppConfig({
          APP_ROLE: 'worker',
          HOSTED_MARKETS: 'AU',
          DATABASE_URL: 'postgresql://u:p@h/d',
          LOG_LEVEL: level,
        }),
      ).toThrow(/LOG_LEVEL: the worker logs at info/);
    }
    for (const level of ['info', 'debug', 'trace']) {
      expect(
        loadAppConfig({
          APP_ROLE: 'worker',
          HOSTED_MARKETS: 'AU',
          DATABASE_URL: 'postgresql://u:p@h/d',
          LOG_LEVEL: level,
        }).logLevel,
      ).toBe(level);
    }
    expect(
      loadAppConfig({
        APP_ROLE: 'api',
        HOSTED_MARKETS: 'AU',
        DATABASE_URL: 'postgresql://u:p@h/d',
        LOG_LEVEL: 'warn',
      }).logLevel,
    ).toBe('warn');
  });

  it('rejects an unknown NODE_ENV and LOG_LEVEL', () => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it.each([undefined, '', 'mysql://localhost/db', 'localhost:5432'])(
    'rejects DATABASE_URL=%p',
    (url) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_URL: url })).toThrow(
        /DATABASE_URL/,
      );
    },
  );

  it('never includes the database password in a validation error', () => {
    expect.assertions(1);
    try {
      loadAppConfig({ DATABASE_URL, PORT: 'abc' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('reports every problem at once', () => {
    try {
      loadAppConfig({ PORT: 'abc' });
      throw new Error('expected loadAppConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).issues).toHaveLength(2);
    }
  });

  it.each(
    ['development', 'test', 'production'].flatMap((nodeEnv) =>
      ['postgresql://drive_migrator:secret@localhost:5432/drive', ''].map(
        (value) => [nodeEnv, value] as const,
      ),
    ),
  )(
    'refuses MIGRATION_DATABASE_URL in the environment (NODE_ENV %s, value %p) without printing its value',
    (nodeEnv, value) => {
      expect.assertions(3);
      try {
        loadAppConfig({ NODE_ENV: nodeEnv, HOSTED_MARKETS: 'AU', MIGRATION_DATABASE_URL: value });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as InvalidConfigError).issues).toEqual([
          expect.stringMatching(/^MIGRATION_DATABASE_URL: must not be set/) as unknown,
        ]);
        expect((error as Error).message).not.toContain('secret');
      }
    },
  );
});
