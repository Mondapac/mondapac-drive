import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { Account, AccountInvariantError, type AccountState } from './account';

const NOW = Temporal.Instant.from('2026-10-07T10:00:00Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';
const NEW_HASH = '$argon2id$v=19$m=65536,t=3,p=1$bmV3c2FsdG5ld3NhbHQ$bmV3dGFnbmV3dGFn';
const EMAIL = { typed: 'Rider@Example.com', normalized: 'rider@example.com' };
const INTEGRATION_EMAIL = { typed: 'key@merchant.invalid', normalized: 'key@merchant.invalid' };

function id(text: string): Id<'Account'> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Account'>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}

const ACCOUNT_ID = id('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'])('Account in market %s (identity design 2.1, 3.1, 3.2)', (code) => {
  const marketId = market(code);
  const register = () =>
    Account.acceptInvitation({
      id: ACCOUNT_ID,
      marketId,
      population: 'courier',
      email: EMAIL,
      displayName: 'Amina Rahman',
      passwordHash: HASH,
      now: NOW,
    });
  const integration = () =>
    Account.createMerchantIntegration({
      id: ACCOUNT_ID,
      marketId,
      email: INTEGRATION_EMAIL,
      displayName: 'Corner Grocer',
      passwordHash: HASH,
      now: NOW,
    });

  describe('createMerchantIntegration', () => {
    it('creates an active, unverified merchant account named after the merchant, version 1', () => {
      const account = integration();

      expect(account.state).toEqual({
        id: ACCOUNT_ID,
        marketId,
        population: 'merchant',
        email: INTEGRATION_EMAIL,
        displayName: 'Corner Grocer',
        status: 'active',
        emailVerifiedAt: null,
        signedUpAt: NOW,
        createdAt: NOW,
        version: 1,
        credential: { passwordHash: HASH, changedAt: NOW },
      });
      expect(account.isEmailVerified).toBe(false);
      expect(account.persistedVersion).toBeNull();
      expect(account.pendingEvents).toEqual([]);
    });

    it('can never take a password, a name, preferences or a status change', () => {
      const account = integration();

      expect(
        account.replacePassword({ passwordHash: NEW_HASH, now: NOW, cause: 'change' }),
      ).toEqual({ ok: false, error: { code: 'account.not-eligible' } });
      expect(account.rename({ displayName: 'Other', now: NOW }).ok).toBe(false);
      expect(account.disable(NOW)).toEqual({ ok: false, error: { code: 'account.not-eligible' } });
      expect(account.state.version).toBe(1);
    });
  });

  describe('restore', () => {
    it.each(['courier', 'admin', 'merchant'] as const)(
      'refuses a %s account without a display name',
      (population) => {
        expect(() =>
          Account.restore({ ...register().state, population, displayName: '  ' }),
        ).toThrow(AccountInvariantError);
      },
    );

    it('starts with no pending event and remembers the stored version', () => {
      const account = Account.restore({ ...register().state, version: 7 });

      expect(account.pendingEvents).toEqual([]);
      expect(account.persistedVersion).toBe(7);
    });
  });

  describe('rehashPassword and credentialChanged (identity design 6.5; Mojtaba N-b)', () => {
    const stored = () => Account.restore({ ...register().state, version: 3 });

    it('replaces the hash, keeps changedAt, raises the version and records no event', () => {
      const account = stored();

      account.rehashPassword(NEW_HASH);

      expect(account.state.credential).toEqual({ passwordHash: NEW_HASH, changedAt: NOW });
      expect(account.state.version).toBe(4);
      expect(account.pendingEvents).toEqual([]);
      expect(account.credentialChanged).toBe(true);
    });

    it('does nothing for the same hash', () => {
      const account = stored();

      account.rehashPassword(HASH);

      expect(account.state.version).toBe(3);
      expect(account.credentialChanged).toBe(false);
    });

    it('knows whether the email is verified', () => {
      expect(stored().isEmailVerified).toBe(true);
      expect(Account.restore({ ...register().state, emailVerifiedAt: null }).isEmailVerified).toBe(
        false,
      );
    });
  });

  describe('replacePassword (identity design 3.5, 3.7, 6.5; slice 4)', () => {
    const LATER = NOW.add({ hours: 5 });
    const verified = () =>
      Account.restore({ ...register().state, emailVerifiedAt: NOW, version: 4 });

    it.each(['reset', 'change'] as const)(
      'on a %s sets the new hash and changedAt, raises the version and records the event',
      (cause) => {
        const account = verified();

        expect(account.replacePassword({ passwordHash: NEW_HASH, now: LATER, cause })).toEqual({
          ok: true,
          value: undefined,
        });

        expect(account.state.credential).toEqual({ passwordHash: NEW_HASH, changedAt: LATER });
        expect(account.state.version).toBe(5);
        expect(account.credentialChanged).toBe(true);
        expect(account.pendingEvents).toEqual([
          expect.objectContaining({
            type: 'identity.account-password-changed.v1',
            aggregateId: ACCOUNT_ID,
            aggregateVersion: 5,
            occurredAt: LATER,
            payload: { accountId: ACCOUNT_ID, cause },
          }),
        ]);
      },
    );

    it('refuses an unverified account (3.7: no reset for it)', () => {
      const account = Account.restore({ ...register().state, emailVerifiedAt: null, version: 2 });

      expect(
        account.replacePassword({ passwordHash: NEW_HASH, now: LATER, cause: 'reset' }),
      ).toEqual({ ok: false, error: { code: 'account.not-eligible' } });
      expect(account.state.version).toBe(2);
      expect(account.state.credential.passwordHash).toBe(HASH);
      expect(account.pendingEvents).toEqual([]);
    });

    it('refuses a disabled account (3.1: no link and no change for it)', () => {
      const account = Account.restore({ ...verified().state, status: 'disabled' });

      expect(
        account.replacePassword({ passwordHash: NEW_HASH, now: LATER, cause: 'change' }),
      ).toEqual({ ok: false, error: { code: 'account.not-eligible' } });
      expect(account.credentialChanged).toBe(false);
    });

    it('records the change even when the new hash equals the old one (a new changedAt)', () => {
      const account = verified();

      account.replacePassword({ passwordHash: HASH, now: LATER, cause: 'change' });

      expect(account.state.credential).toEqual({ passwordHash: HASH, changedAt: LATER });
      expect(account.credentialChanged).toBe(true);
      expect(account.pendingEvents).toHaveLength(1);
    });
  });
});
