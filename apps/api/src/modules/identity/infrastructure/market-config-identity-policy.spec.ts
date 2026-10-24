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

  it('reads each Market its own password rules', () => {
    expect(policy.passwordRules(testMarketContext('AU', 'default'))).toEqual({
      minLength: 15,
      maxLength: 128,
    });
    expect(policy.passwordRules(testMarketContext('ZZ', 'default'))).toEqual({
      minLength: 16,
      maxLength: 100,
    });
  });

  it('reads each Market its own notice interval', () => {
    expect(policy.existingAccountNoticeHours(testMarketContext('AU', 'default'))).toBe(24);
    expect(policy.existingAccountNoticeHours(testMarketContext('ZZ', 'default'))).toBe(12);
  });

  it('reads each Market its own customer session lifetime, in seconds, and none for others', () => {
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'customer')).toEqual({
      idleTimeoutSeconds: 14 * 86_400,
      absoluteLifetimeSeconds: 30 * 86_400,
    });
    expect(policy.sessionLifetime(testMarketContext('ZZ', 'default'), 'customer')).toEqual({
      idleTimeoutSeconds: 7 * 86_400,
      absoluteLifetimeSeconds: 14 * 86_400,
    });
    // Slice 7b: the admin session (30 minutes idle and 12 hours for AU), never kept.
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'admin')).toEqual({
      idleTimeoutSeconds: 30 * 60,
      absoluteLifetimeSeconds: 12 * 3600,
    });
    expect(policy.sessionLifetime(testMarketContext('ZZ', 'default'), 'admin')).toEqual({
      idleTimeoutSeconds: 20 * 60,
      absoluteLifetimeSeconds: 8 * 3600,
    });
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'admin', true)).toBeNull();
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'customer', true)).toBeNull();
  });

  it('reads each Market its seller lifetimes, "keep me signed in" and approval (slice 5)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

    expect(policy.sessionLifetime(au, 'seller')).toEqual({
      idleTimeoutSeconds: 12 * 3600,
      absoluteLifetimeSeconds: 24 * 3600,
    });
    expect(policy.sessionLifetime(au, 'seller', true)).toEqual({
      idleTimeoutSeconds: 14 * 86_400,
      absoluteLifetimeSeconds: 30 * 86_400,
    });
    expect(policy.sessionLifetime(zz, 'seller')).toEqual({
      idleTimeoutSeconds: 10 * 3600,
      absoluteLifetimeSeconds: 20 * 3600,
    });
    expect(policy.sellerApprovalRequired(au)).toBe(true);
    expect(policy.sellerApprovalRequired(zz)).toBe(false);
    expect(policy.target(au, 'seller', 'verify-email')).toBe(
      'https://seller.au.mondapac.test/confirm-email',
    );
    expect(policy.target(zz, 'seller', 'sign-in')).toBe('https://seller.zz.test/konto/anmelden');
  });

  it('reads each Market its own throttles and retention (identity design 6.8, H3)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

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
  });

  it('reads each Market its own links, retention of unverified accounts and sender (slice 3)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

    expect(policy.linkLifetimeMinutes(au, 'verify-email')).toBe(1440);
    expect(policy.linkLifetimeMinutes(zz, 'verify-email')).toBe(720);
    // SEL-05, ACC-04: exactly 60 minutes in every Market (slice 4).
    expect(policy.linkLifetimeMinutes(au, 'reset-password')).toBe(60);
    expect(policy.linkLifetimeMinutes(zz, 'reset-password')).toBe(60);
    // Slice 7b: the admin's enrolment link.
    expect(policy.linkLifetimeMinutes(au, 'enrol-second-factor')).toBe(60);
    expect(policy.linkLifetimeMinutes(zz, 'enrol-second-factor')).toBe(45);
    expect(policy.unverifiedAccountRetentionDays(au)).toBe(7);
    expect(policy.unverifiedAccountRetentionDays(zz)).toBe(5);
    expect(policy.mailSender(au)).toEqual({
      address: 'no-reply@au.mondapac.test',
      name: 'MondaPac',
    });
    expect(policy.mailSender(zz)).toEqual({ address: 'noreply@zz.test', name: 'ZZ Shop' });
    expect(policy.target(au, 'customer', 'verify-email')).toBe(
      'https://storefront.au.mondapac.test/account/confirm-email',
    );
    expect(policy.target(zz, 'customer', 'sign-in')).toBe(
      'https://storefront.zz.test/konto/anmelden',
    );
    // A page of another population is never resolved, even when the type is widened.
    expect(policy.target<Population>(au, 'admin', 'verify-email')).toBeNull();
  });

  it('resolves the admin review queue page only for the admin population (identity design 8.7)', () => {
    for (const code of ['AU', 'ZZ']) {
      const market = testMarketContext(code, 'default');
      const queue = policy.target(market, 'admin', 'seller-review-queue');

      expect(queue).toMatch(/^https:\/\/admin\./);
      expect(queue).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(policy.target<Population>(market, 'seller', 'seller-review-queue')).toBeNull();
      expect(policy.target<Population>(market, 'customer', 'seller-review-queue')).toBeNull();
    }
    expect(
      policy.target(testMarketContext('AU', 'default'), 'admin', 'seller-review-queue'),
    ).not.toBe(policy.target(testMarketContext('ZZ', 'default'), 'admin', 'seller-review-queue'));
  });

  it('reads each Market its re-apply limit and seller accept page (slice 9, identity design 3.3)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

    expect(policy.sellerReapplyLimit(au)).toBe(3);
    expect(policy.sellerReapplyLimit(zz)).toBe(3);
    expect(policy.target(au, 'seller', 'accept-invitation')).toBe(
      'https://seller.au.mondapac.test/accept-invitation',
    );
    expect(policy.target(zz, 'seller', 'accept-invitation')).toBe(
      'https://seller.zz.test/konto/einladung',
    );
    // The admin panel's acceptance page stays its own.
    expect(policy.target(au, 'admin', 'accept-invitation')).toBe(
      'https://admin.au.mondapac.test/accept-invitation',
    );
  });

  it('reads each Market its custom-role limits per scope (slice 10, identity design 2.3)', () => {
    for (const code of ['AU', 'ZZ']) {
      const market = testMarketContext(code, 'default');
      expect(policy.customRoleLimit(market, 'seller')).toBe(20);
      expect(policy.customRoleLimit(market, 'platform')).toBe(50);
    }
  });

  it('answers null for the role limits when a Market configures none (fail closed)', () => {
    const file = JSON.parse(
      readFileSync(path.join(TEST_MARKET_CONFIG_DIRS[1], 'ZZ.json'), 'utf8'),
    ) as { identity: { customRoleLimits?: object } };
    delete file.identity.customRoleLimits;
    const directory = mkdtempSync(path.join(tmpdir(), 'markets-without-limits-'));
    writeFileSync(path.join(directory, 'ZZ.json'), JSON.stringify(file));
    const without = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs([directory], [testMarketId('ZZ')])),
    );
    const zz = testMarketContext('ZZ', 'default');

    expect(without.customRoleLimit(zz, 'seller')).toBeNull();
    expect(without.customRoleLimit(zz, 'platform')).toBeNull();
  });

  it('answers null for both when a Market configures neither, so the flows fail closed', () => {
    // A copy of ZZ without the two slice 9 keys; the checked-in files keep them.
    const file = JSON.parse(
      readFileSync(path.join(TEST_MARKET_CONFIG_DIRS[1], 'ZZ.json'), 'utf8'),
    ) as { identity: { sellerReapplyLimit?: number; links: { targets: { seller: object } } } };
    delete file.identity.sellerReapplyLimit;
    delete (file.identity.links.targets.seller as Record<string, string>)['accept-invitation'];
    const directory = mkdtempSync(path.join(tmpdir(), 'markets-without-'));
    writeFileSync(path.join(directory, 'ZZ.json'), JSON.stringify(file));
    const without = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs([directory], [testMarketId('ZZ')])),
    );
    const zz = testMarketContext('ZZ', 'default');

    expect(without.sellerReapplyLimit(zz)).toBeNull();
    expect(without.target(zz, 'seller', 'accept-invitation')).toBeNull();
    expect(without.target(zz, 'seller', 'sign-in')).toBe('https://seller.zz.test/konto/anmelden');
  });

  it('refuses a Market this Region Stack does not host, with no fallback', () => {
    const onlyZz = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, [testMarketId('ZZ')])),
    );

    expect(() => onlyZz.passwordRules(testMarketContext('AU', 'default'))).toThrow(
      MarketNotHostedError,
    );
  });

  it('reads each Market its own invitation lifetimes, challenge and second-factor counter (slice 7b)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

    expect(policy.invitationLifetimeMinutes(au, 'admin')).toBe(72 * 60);
    expect(policy.invitationLifetimeMinutes(au, 'seller-owner')).toBe(7 * 24 * 60);
    expect(policy.invitationLifetimeMinutes(au, 'staff')).toBe(7 * 24 * 60);
    expect(policy.invitationLifetimeMinutes(zz, 'admin')).toBe(48 * 60);
    expect(policy.invitationLifetimeMinutes(zz, 'seller-owner')).toBe(5 * 24 * 60);
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
      'https://admin.au.mondapac.test/second-factor/enrol',
    );
  });
});
