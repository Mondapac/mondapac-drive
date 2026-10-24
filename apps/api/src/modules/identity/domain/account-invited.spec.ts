import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { Account, AccountInvariantError } from './account';
import { parseEmailAddress } from './email-address';

// Slice 7b: an account created by accepting an invitation (identity design 3.1, 3.2, 3.4; AC 22,
// AC 29): active and verified at once (the link proved the mailbox), with exactly the invited
// address and the name the invitee gave. No event of its own: the invitation's acceptance event
// names the account (8.2).

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');

function id<T extends string>(text: string): Id<T> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}
const email = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};

const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'] as const)('Account.acceptInvitation in market %s', (code) => {
  const marketId = market(code);

  it('creates an active, verified admin account with the invited address and given name', () => {
    const account = Account.acceptInvitation({
      id: ACCOUNT_ID,
      marketId,
      population: 'admin',
      email: email('New.Admin@Example.test'),
      displayName: 'Nadia Admin',
      passwordHash: '$argon2id$fake',
      now: NOW,
    });
    expect(account.state).toMatchObject({
      id: ACCOUNT_ID,
      marketId,
      population: 'admin',
      email: { typed: 'New.Admin@Example.test', normalized: 'new.admin@example.test' },
      displayName: 'Nadia Admin',
      status: 'active',
      emailVerifiedAt: NOW,
      signedUpAt: NOW,
      createdAt: NOW,
      version: 1,
      credential: { passwordHash: '$argon2id$fake', changedAt: NOW },
    });
    expect(account.isEmailVerified).toBe(true);
    expect(account.persistedVersion).toBeNull();
    expect(account.pendingEvents).toEqual([]);
  });

  it('refuses a merchant (merchants are never invited) and an empty name', () => {
    expect(() =>
      Account.acceptInvitation({
        id: ACCOUNT_ID,
        marketId,
        population: 'merchant' as 'admin',
        email: email('a@example.test'),
        displayName: 'Someone',
        passwordHash: '$argon2id$fake',
        now: NOW,
      }),
    ).toThrow(TypeError);
    expect(() =>
      Account.acceptInvitation({
        id: ACCOUNT_ID,
        marketId,
        population: 'admin',
        email: email('a@example.test'),
        displayName: '   ',
        passwordHash: '$argon2id$fake',
        now: NOW,
      }),
    ).toThrow(AccountInvariantError);
  });
});
