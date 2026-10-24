import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Population } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  testMarketId,
} from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import {
  MarketNotHostedError,
  MarketRegistry,
} from '../../../platform/market-config/market-registry';
import { MarketConfigIdentityPolicy } from './market-config-identity-policy';

describe('MarketConfigIdentityPolicy (identity design 8.5)', () => {
  const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const policy = new MarketConfigIdentityPolicy(registry);
  const au = testMarketContext('AU', 'default');
  const zz = testMarketContext('ZZ', 'default');

  it('reads each Market its own password rules', () => {
    expect(policy.passwordRules(au)).toEqual({ minLength: 15, maxLength: 128 });
    expect(policy.passwordRules(zz)).toEqual({ minLength: 16, maxLength: 100 });
  });

  it('reads each Market its own admin and courier session lifetimes, in seconds', () => {
    expect(policy.sessionLifetime(au, 'admin')).toEqual({
      idleTimeoutSeconds: 30 * 60,
      absoluteLifetimeSeconds: 12 * 3600,
    });
    expect(policy.sessionLifetime(zz, 'admin')).toEqual({
      idleTimeoutSeconds: 20 * 60,
      absoluteLifetimeSeconds: 8 * 3600,
    });
    expect(policy.sessionLifetime(au, 'courier')).toEqual({
      idleTimeoutSeconds: 24 * 3600,
      absoluteLifetimeSeconds: 30 * 86_400,
    });
    expect(policy.sessionLifetime(zz, 'courier')).toEqual({
      idleTimeoutSeconds: 10 * 3600,
      absoluteLifetimeSeconds: 14 * 86_400,
    });
    // A merchant never signs in: its sessions are API keys, with their own lifetime.
    expect(policy.sessionLifetime(au, 'merchant')).toBeNull();
  });

  it('reads each Market its own API key lifetime, idle equal to absolute', () => {
    expect(policy.apiKeyLifetime(au)).toEqual({
      idleTimeoutSeconds: 365 * 86_400,
      absoluteLifetimeSeconds: 365 * 86_400,
    });
    expect(policy.apiKeyLifetime(zz)).toEqual({
      idleTimeoutSeconds: 90 * 86_400,
      absoluteLifetimeSeconds: 90 * 86_400,
    });
  });

  it('reads each Market its own throttles and retention (identity design 6.8, H3)', () => {
    expect(policy.signInThrottles(au).accountOrigin).toEqual({
      limit: 5,
      windowMinutes: 15,
      blockMinutes: 15,
    });
    expect(policy.signInThrottles(zz).accountOrigin).toEqual({
      limit: 4,
      windowMinutes: 10,
      blockMinutes: 20,
    });
    expect(policy.mailThrottles(au).account.limit).toBe(3);
    expect(policy.mailThrottles(zz).account.limit).toBe(2);
    expect(policy.signInRecordRetentionDays(au)).toBe(90);
    expect(policy.signInRecordRetentionDays(zz)).toBe(60);
    expect(policy.signOutOthersThrottle(au)).toEqual({
      limit: 5,
      windowMinutes: 60,
      blockMinutes: 0,
    });
    expect(policy.signOutOthersThrottle(zz)).toEqual({
      limit: 3,
      windowMinutes: 30,
      blockMinutes: 0,
    });
  });

  it('reads each Market its own links, sender and pages per population', () => {
    // SEL-05, ACC-04: exactly 60 minutes in every Market.
    expect(policy.linkLifetimeMinutes(au, 'reset-password')).toBe(60);
    expect(policy.linkLifetimeMinutes(zz, 'reset-password')).toBe(60);
    expect(policy.linkLifetimeMinutes(au, 'enrol-second-factor')).toBe(60);
    expect(policy.linkLifetimeMinutes(zz, 'enrol-second-factor')).toBe(45);
    expect(policy.mailSender(au)).toEqual({
      address: 'no-reply@au.drive.mondapac.test',
      name: 'Mondapac Drive',
    });
    expect(policy.mailSender(zz)).toEqual({ address: 'noreply@zz.test', name: 'ZZ Drive' });
    expect(policy.target(au, 'courier', 'reset-password')).toBe(
      'https://courier.au.drive.mondapac.test/reset-password',
    );
    expect(policy.target(zz, 'courier', 'sign-in')).toBe('https://courier.zz.test/anmelden');
    expect(policy.target(zz, 'admin', 'accept-invitation')).toBe(
      'https://dispatch.zz.test/einladung',
    );
    // A page of another population is never resolved, even when the type is widened.
    expect(policy.target<Population>(au, 'courier', 'enrol-second-factor')).toBeNull();
    expect(policy.target<Population>(au, 'merchant', 'sign-in')).toBeNull();
  });

  it('reads each Market its custom-role limit (identity design 2.3)', () => {
    expect(policy.customRoleLimit(au, 'platform')).toBe(50);
    expect(policy.customRoleLimit(zz, 'platform')).toBe(50);
  });

  it('answers null when a Market configures no role limit, API keys or courier pages (fail closed)', () => {
    const file = JSON.parse(
      readFileSync(path.join(TEST_MARKET_CONFIG_DIRS[1], 'ZZ.json'), 'utf8'),
    ) as {
      identity: {
        customRoleLimits?: object;
        apiKeys?: object;
        sessions: { courier?: object };
        links: { targets: { courier?: object } };
      };
    };
    delete file.identity.customRoleLimits;
    delete file.identity.apiKeys;
    // A Market without courier pages has no courier sessions either (the schema pairs them).
    delete file.identity.sessions.courier;
    delete file.identity.links.targets.courier;
    const directory = mkdtempSync(path.join(tmpdir(), 'markets-without-'));
    writeFileSync(path.join(directory, 'ZZ.json'), JSON.stringify(file));
    const without = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs([directory], [testMarketId('ZZ')])),
    );

    expect(without.customRoleLimit(zz, 'platform')).toBeNull();
    expect(without.apiKeyLifetime(zz)).toBeNull();
    expect(without.target(zz, 'courier', 'sign-in')).toBeNull();
    expect(without.sessionLifetime(zz, 'courier')).toBeNull();
    expect(without.target(zz, 'admin', 'sign-in')).toBe('https://dispatch.zz.test/anmelden');
  });

  it('refuses a Market this Region Stack does not host, with no fallback', () => {
    const onlyZz = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, [testMarketId('ZZ')])),
    );

    expect(() => onlyZz.passwordRules(au)).toThrow(MarketNotHostedError);
  });

  it('reads each Market its own invitation lifetimes, challenge and second-factor counter', () => {
    expect(policy.invitationLifetimeMinutes(au, 'admin')).toBe(72 * 60);
    expect(policy.invitationLifetimeMinutes(au, 'courier')).toBe(7 * 24 * 60);
    expect(policy.invitationLifetimeMinutes(zz, 'admin')).toBe(48 * 60);
    expect(policy.invitationLifetimeMinutes(zz, 'courier')).toBe(5 * 24 * 60);
    expect(policy.challengePolicy(au)).toEqual({ maxAttempts: 5, lifetimeSeconds: 300 });
    expect(policy.challengePolicy(zz)).toEqual({ maxAttempts: 4, lifetimeSeconds: 240 });
    expect(policy.secondFactorThrottle(au)).toEqual({
      limit: 10,
      windowMinutes: 24 * 60,
      blockMinutes: 24 * 60,
    });
    expect(policy.secondFactorThrottle(zz)).toEqual({
      limit: 8,
      windowMinutes: 48 * 60,
      blockMinutes: 48 * 60,
    });
    expect(policy.target(au, 'admin', 'enrol-second-factor')).toBe(
      'https://dispatch.au.drive.mondapac.test/second-factor/enrol',
    );
  });
});
