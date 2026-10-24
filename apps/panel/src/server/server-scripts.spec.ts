import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ADR-0037 decision 9: `dev` and `start` both run server.mjs, never `next dev` or `server.js`.
const serverFile = path.resolve('server.mjs');
const emptyDir = () => mkdtempSync(path.join(tmpdir(), 'panel-'));
const baseEnv = {
  NODE_ENV: 'test' as const,
  PATH: process.env['PATH'] ?? '',
  API_BASE_URL: 'http://localhost:3000',
  PANEL_HOSTS: 'http://admin.localhost:3002=AU',
  PANEL_PASSWORD_LENGTH: '15-128',
  PANEL_MARKET_NAME: 'Australia',
  PANEL_LOCALE: 'en-AU',
  PANEL_SUPPORT_EMAIL: 'support@example.com',
};

describe('package scripts', () => {
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('start the panel through server.mjs', () => {
    expect(scripts['dev']).toBe('node server.mjs --dev');
    expect(scripts['start']).toBe('node server.mjs');
  });

  it('server.mjs reads the client-address source before Next.js prepares', () => {
    const source = readFileSync('server.mjs', 'utf8');
    const parse = source.indexOf('parseClientAddressSource(process.env)');
    expect(parse).toBeGreaterThan(-1);
    expect(parse).toBeLessThan(source.indexOf('app.prepare()'));
    expect(source).toContain('createPanelServer');
    expect(source).toContain('handleUpgrade: dev ? app.getUpgradeHandler() : undefined');
  });
});

describe('server.mjs start-up', () => {
  it.each([[[]], [['--dev']]])(
    'refuses to start without CLIENT_ADDRESS_SOURCE (args %j)',
    (args: string[]) => {
      const result = spawnSync(process.execPath, [serverFile, ...args], {
        cwd: emptyDir(),
        env: baseEnv,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CLIENT_ADDRESS_SOURCE is required');
      expect(result.stdout).not.toContain('panel.listening');
    },
  );

  it('refuses socket mode with an edge variable set', () => {
    const result = spawnSync(process.execPath, [serverFile], {
      cwd: emptyDir(),
      env: { ...baseEnv, CLIENT_ADDRESS_SOURCE: 'socket', EDGE_CIDRS: '127.0.0.0/16' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not set EDGE_CIDRS');
  });
});
