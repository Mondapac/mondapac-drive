import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { Account, AccountInvariantError, type AccountState } from './account';

const NOW = Temporal.Instant.from('2026-10-07T10:00:00Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';
const NEW_HASH = '$argon2id$v=19$m=65536,t=3,p=1$bmV3c2FsdG5ld3NhbHQ$bmV3dGFnbmV3dGFn';
const EMAIL = { typed: 'Customer@Example.com', normalized: 'customer@example.com' };

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

describe.each(['AU', 'ZZ'])('Account in market %s (identity design 2.1, 3.1, 3.2, 6.7)', (code) => {
  const marketId = market(code);
  const register = () =>
    Account.registerCustomer({
      id: ACCOUNT_ID,
      marketId,
      email: EMAIL,
      passwordHash: HASH,
      now: NOW,
    });

  describe('registerCustomer', () => {
    it('creates an active, unverified customer account with no display name, version 1', () => {
      const account = register();

      expect(account.state).toEqual<AccountState>({
        id: ACCOUNT_ID,
        marketId,
        population: 'customer',
        email: EMAIL,
        displayName: null,
        status: 'active',
        emailVerifiedAt: null,
        existingAccountNoticeAt: null,
        signedUpAt: NOW,
        createdAt: NOW,
        version: 1,
        credential: { passwordHash: HASH, changedAt: NOW },
      });
      expect(account.persistedVersion).toBeNull();
    });

    it('records customer-account-registered with the account id only', () => {
      const [event, ...rest] = register().pendingEvents;

      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'identity.customer-account-registered.v1',
        aggregateType: 'account',
        aggregateId: ACCOUNT_ID,
        aggregateVersion: 1,
        occurredAt: NOW,
        payload: { accountId: ACCOUNT_ID },
      });
    });

    it('takes no display name: the factory has no such input', () => {
      const input = { id: ACCOUNT_ID, marketId, email: EMAIL, passwordHash: HASH, now: NOW };
      const withName = { ...input, displayName: 'Injected Name' };

      expect(Account.registerCustomer(withName).state.displayName).toBeNull();
    });
  });

  describe('signUpAgain', () => {
    const LATER = NOW.add({ hours: 2 });

    it('on an unverified account, replaces the password and restarts the purge anchor', () => {
      const account = Account.restore(register().state);

      const outcome = account.signUpAgain({
        passwordHash: NEW_HASH,
        now: LATER,
        noticeHours: 24,
        mailAllowed: true,
      });

      expect(outcome).toBe('unverified-replaced');
      expect(account.state).toMatchObject({
        signedUpAt: LATER,
        createdAt: NOW,
        version: 2,
        displayName: null,
        emailVerifiedAt: null,
        credential: { passwordHash: NEW_HASH, changedAt: LATER },
      });
      expect(account.persistedVersion).toBe(1);
      expect(account.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.sign-up-repeated.v1',
          aggregateVersion: 2,
          occurredAt: LATER,
          payload: { accountId: ACCOUNT_ID, cause: 'unverified-replaced' },
        }),
      ]);
    });

    describe('on a verified account', () => {
      const verified = (noticeAt: Temporal.Instant | null) =>
        Account.restore({
          ...register().state,
          emailVerifiedAt: NOW.add({ minutes: 5 }),
          existingAccountNoticeAt: noticeAt,
        });

      it('never touches the password or the purge anchor, and records a notice', () => {
        const account = verified(null);

        expect(
          account.signUpAgain({
            passwordHash: NEW_HASH,
            now: LATER,
            noticeHours: 24,
            mailAllowed: true,
          }),
        ).toBe('verified-notice');
        expect(account.state).toMatchObject({
          credential: { passwordHash: HASH, changedAt: NOW },
          signedUpAt: NOW,
          existingAccountNoticeAt: LATER,
          version: 2,
        });
        expect(account.pendingEvents).toEqual([
          expect.objectContaining({
            payload: { accountId: ACCOUNT_ID, cause: 'verified-notice' },
          }),
        ]);
      });

      it('sends at most one notice per interval of the Market', () => {
        const account = verified(LATER.subtract({ hours: 23, minutes: 59 }));

        expect(
          account.signUpAgain({
            passwordHash: NEW_HASH,
            now: LATER,
            noticeHours: 24,
            mailAllowed: true,
          }),
        ).toBe('unchanged');
        expect(account.state.version).toBe(1);
        expect(account.pendingEvents).toEqual([]);
      });

      it('records no notice when the mail counters refused the mail (Mojtaba item 3)', () => {
        const account = verified(null);

        expect(
          account.signUpAgain({
            passwordHash: NEW_HASH,
            now: LATER,
            noticeHours: 24,
            mailAllowed: false,
          }),
        ).toBe('unchanged');
        expect(account.state).toMatchObject({ existingAccountNoticeAt: null, version: 1 });
        expect(account.pendingEvents).toEqual([]);
      });

      it('sends the next notice once the interval has passed', () => {
        const account = verified(LATER.subtract({ hours: 12 }));

        expect(
          account.signUpAgain({
            passwordHash: NEW_HASH,
            now: LATER,
            noticeHours: 12,
            mailAllowed: true,
          }),
        ).toBe('verified-notice');
      });
    });
  });

  describe('verifyEmail (identity design 3.2)', () => {
    const LATER = NOW.add({ hours: 3 });

    it('sets the instant, raises the version and records account-email-verified', () => {
      const account = Account.restore({ ...register().state, version: 2 });

      expect(account.verifyEmail(LATER)).toBe(true);

      expect(account.state).toMatchObject({ emailVerifiedAt: LATER, version: 3 });
      expect(account.isEmailVerified).toBe(true);
      expect(account.credentialChanged).toBe(false);
      expect(account.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.account-email-verified.v1',
          aggregateId: ACCOUNT_ID,
          aggregateVersion: 3,
          occurredAt: LATER,
          payload: { accountId: ACCOUNT_ID, population: 'customer' },
        }),
      ]);
    });

    it('does not change an account already verified', () => {
      const account = Account.restore({ ...register().state, emailVerifiedAt: NOW });

      expect(account.verifyEmail(LATER)).toBe(false);
      expect(account.state).toMatchObject({ emailVerifiedAt: NOW, version: 1 });
      expect(account.pendingEvents).toEqual([]);
    });
  });

  describe('restore', () => {
    it.each(['seller', 'admin'] as const)(
      'refuses a %s account without a display name',
      (population) => {
        expect(() => Account.restore({ ...register().state, population })).toThrow(
          AccountInvariantError,
        );
      },
    );

    it('accepts a seller account with a display name', () => {
      expect(
        Account.restore({ ...register().state, population: 'seller', displayName: 'Shop' }).state
          .population,
      ).toBe('seller');
    });

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

    it('reports no credential change when only the notice instant changed', () => {
      const account = Account.restore({
        ...register().state,
        emailVerifiedAt: NOW,
        version: 3,
      });

      account.signUpAgain({
        passwordHash: NEW_HASH,
        now: NOW.add({ hours: 30 }),
        noticeHours: 24,
        mailAllowed: true,
      });

      expect(account.state.version).toBe(4);
      expect(account.credentialChanged).toBe(false);
    });

    it('reports a credential change when an unverified sign-up replaced the password', () => {
      const account = stored();

      account.signUpAgain({
        passwordHash: NEW_HASH,
        now: NOW.add({ hours: 1 }),
        noticeHours: 24,
        mailAllowed: true,
      });

      expect(account.credentialChanged).toBe(true);
    });

    it('knows whether the email is verified', () => {
      expect(stored().isEmailVerified).toBe(false);
      expect(Account.restore({ ...register().state, emailVerifiedAt: NOW }).isEmailVerified).toBe(
        true,
      );
    });
  });

  describe('registerSeller (identity design 2.1, 3.1; slice 5)', () => {
    const registerSeller = (displayName = 'Amina Rahman') =>
      Account.registerSeller({
        id: ACCOUNT_ID,
        marketId,
        email: EMAIL,
        displayName,
        passwordHash: HASH,
        now: NOW,
      });

    it('creates an active, unverified seller account with its display name, version 1', () => {
      expect(registerSeller().state).toEqual<AccountState>({
        id: ACCOUNT_ID,
        marketId,
        population: 'seller',
        email: EMAIL,
        displayName: 'Amina Rahman',
        status: 'active',
        emailVerifiedAt: null,
        existingAccountNoticeAt: null,
        signedUpAt: NOW,
        createdAt: NOW,
        version: 1,
        credential: { passwordHash: HASH, changedAt: NOW },
      });
    });

    it('records no event: 8.2 has none for a seller account, the seller is published later', () => {
      expect(registerSeller().pendingEvents).toEqual([]);
    });

    it('refuses an empty display name', () => {
      expect(() => registerSeller('')).toThrow(AccountInvariantError);
    });

    it('replaces the name with the password on an unverified repeated sign-up (6.7)', () => {
      const account = Account.restore(registerSeller().state);

      account.signUpAgain({
        passwordHash: NEW_HASH,
        displayName: 'Amina R.',
        now: NOW.add({ hours: 1 }),
        noticeHours: 24,
        mailAllowed: true,
      });

      expect(account.state).toMatchObject({ displayName: 'Amina R.', version: 2 });
    });

    it('keeps the name of a verified account, and never sets one on a customer', () => {
      const verified = Account.restore({ ...registerSeller().state, emailVerifiedAt: NOW });
      verified.signUpAgain({
        passwordHash: NEW_HASH,
        displayName: 'Someone Else',
        now: NOW.add({ hours: 48 }),
        noticeHours: 24,
        mailAllowed: true,
      });
      expect(verified.state.displayName).toBe('Amina Rahman');

      const customer = Account.restore(register().state);
      customer.signUpAgain({
        passwordHash: NEW_HASH,
        displayName: 'Injected',
        now: NOW.add({ hours: 1 }),
        noticeHours: 24,
        mailAllowed: true,
      });
      expect(customer.state.displayName).toBeNull();
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

    it('refuses an unverified account (3.7: no reset for it; it signs up again)', () => {
      const account = Account.restore({ ...register().state, version: 2 });

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
