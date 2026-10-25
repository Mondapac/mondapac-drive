import { databaseNameOf, devSeedRefusal } from './guard';

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
});
