import {
  databaseNameOf,
  devSeedRefusal,
  dropOutboundProviders,
  OUTBOUND_PROVIDER_VARIABLES,
} from './guard';

const url = (name: string) => `postgresql://drive_api:secret@localhost:5432/${name}`;

describe('devSeedRefusal', () => {
  it.each([
    ['development', 'drive_dev'],
    ['test', 'drive_test'],
    ['development', 'drive_au_test'],
  ])('lets NODE_ENV %s seed %s', (nodeEnv, name) => {
    expect(devSeedRefusal({ NODE_ENV: nodeEnv, DATABASE_URL: url(name) })).toBeNull();
  });

  it.each([undefined, 'production', 'staging', 'Development'])(
    'refuses NODE_ENV %s, even on a _dev database',
    (nodeEnv) => {
      expect(devSeedRefusal({ NODE_ENV: nodeEnv, DATABASE_URL: url('drive_dev') })).toMatch(
        /NODE_ENV/,
      );
    },
  );

  it.each(['drive', 'drive_prod', 'drive_dev_copy', 'dev', 'drive-dev', 'drive_devx'])(
    'refuses the database %s',
    (name) => {
      expect(devSeedRefusal({ NODE_ENV: 'test', DATABASE_URL: url(name) })).toMatch(
        /_dev or _test/,
      );
    },
  );

  it('refuses a missing or foreign URL without echoing it', () => {
    for (const DATABASE_URL of [undefined, '', 'mysql://u:p@h/drive_dev', 'not a url']) {
      const refusal = devSeedRefusal({ NODE_ENV: 'test', DATABASE_URL });
      expect(refusal).toMatch(/DATABASE_URL/);
      expect(refusal).not.toContain('mysql');
    }
    expect(devSeedRefusal({ NODE_ENV: 'test', DATABASE_URL: url('drive') })).not.toContain(
      'secret',
    );
  });

  it('reads the database name, decoded, and nothing else', () => {
    expect(databaseNameOf('postgres://u@h/drive%5Fdev?sslmode=require')).toBe('drive_dev');
    expect(databaseNameOf('postgresql://u@h/')).toBeNull();
    expect(databaseNameOf('postgresql://u@h/a/b_dev')).toBeNull();
  });

  it('refuses a remote database or Redis unless the host is listed', () => {
    const remote = 'postgresql://u:p@db.staging.example.com:5432/drive_test';
    expect(devSeedRefusal({ NODE_ENV: 'test', DATABASE_URL: remote })).toMatch(
      /host must be local/,
    );
    expect(
      devSeedRefusal({
        NODE_ENV: 'test',
        DATABASE_URL: remote,
        DEV_SEED_ALLOWED_HOSTS: 'other.example.com, DB.staging.example.com',
      }),
    ).toBeNull();
    expect(
      devSeedRefusal({
        NODE_ENV: 'test',
        DATABASE_URL: url('drive_test'),
        REDIS_URL: 'rediss://cache.example.com:6380',
      }),
    ).toMatch(/REDIS_URL/);
    expect(
      devSeedRefusal({
        NODE_ENV: 'test',
        DATABASE_URL: url('drive_test'),
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).toBeNull();
  });
});

describe('dropOutboundProviders', () => {
  it('removes every SMS, push, payment and routing key, and nothing else', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', ZZ_ROUTING_API_KEY: 'k' };
    for (const name of OUTBOUND_PROVIDER_VARIABLES) env[name] = 'secret';
    dropOutboundProviders(env, ['ZZ_ROUTING_API_KEY']);
    expect(env).toEqual({ NODE_ENV: 'test' });
    expect(OUTBOUND_PROVIDER_VARIABLES).toEqual(
      expect.arrayContaining(['TWILIO_AUTH_TOKEN', 'STRIPE_SECRET_KEY', 'EXPO_ACCESS_TOKEN']),
    );
  });
});
