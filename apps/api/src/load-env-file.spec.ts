import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFile } from './load-env-file';

describe('loadEnvFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mondapac-env-'));
    file = path.join(dir, '.env');
    writeFileSync(
      file,
      [
        'HOSTED_MARKETS=AU',
        'DATABASE_URL=postgresql://drive_api:x@localhost:5432/drive',
        'MIGRATION_DATABASE_URL=postgresql://drive_migrator:x@localhost:5432/drive',
        'LOG_LEVEL=debug',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never hands the migration role URL to the application', () => {
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile(file, env);

    expect(env).toEqual({
      HOSTED_MARKETS: 'AU',
      DATABASE_URL: 'postgresql://drive_api:x@localhost:5432/drive',
      LOG_LEVEL: 'debug',
    });
  });

  it('keeps variables the environment already has', () => {
    const env: NodeJS.ProcessEnv = { LOG_LEVEL: 'warn' };

    loadEnvFile(file, env);

    expect(env.LOG_LEVEL).toBe('warn');
  });

  it('does nothing without a file', () => {
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile(path.join(dir, 'missing.env'), env);

    expect(env).toEqual({});
  });
});
