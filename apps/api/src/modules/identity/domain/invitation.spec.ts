import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { parseEmailAddress } from './email-address';
import { Invitation, InvitationInvariantError, type InvitationState } from './invitation';
import {
  challengeIsOpen,
  challengeMatchesCredential,
  ChallengePolicyError,
  issueChallenge,
} from './sign-in-challenge';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const HASH = new Uint8Array(32).fill(7);
const OTHER_HASH = new Uint8Array(32).fill(9);

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

const INVITATION_ID = id<'Invitation'>('01990000-0000-7000-8000-0000000000c1');
const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d1');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000e1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const CHALLENGE_ID = id<'SignInChallenge'>('01990000-0000-7000-8000-0000000000b1');

// Each fixture Market has its own lifetime (here AU 72 hours for admins, ZZ 48): nothing
// assumes AU's.
describe.each([
  ['AU', 4320],
  ['ZZ', 2880],
] as const)('Invitation in market %s (identity design 3.4)', (code, lifetimeMinutes) => {
  const marketId = market(code);
  const admin = () =>
    Invitation.issue({
      id: INVITATION_ID,
      marketId,
      kind: 'admin',
      email: email('New.Admin@Example.test'),
      roleId: ROLE_ID,
      sellerId: null,
      invitedByAccountId: null,
      now: NOW,
    });
  const dispatched = () => {
    const invitation = Invitation.restore(admin().state);
    expect(invitation.dispatch(HASH, NOW, lifetimeMinutes)).toEqual({ ok: true, value: undefined });
    return Invitation.restore(invitation.state);
  };

  it('is issued pending, without a token, and is not usable before dispatch (6.6)', () => {
    const invitation = admin();
    expect(invitation.state).toMatchObject({
      state: 'pending',
      tokenHash: null,
      expiresAt: null,
      version: 1,
      email: { typed: 'New.Admin@Example.test', normalized: 'new.admin@example.test' },
    });
    expect(invitation.statusAt(NOW)).toBe('pending');
    expect(invitation.usableAt(NOW)).toBe(false);
    expect(invitation.accept(ACCOUNT_ID, NOW)).toEqual({
      ok: false,
      error: { code: 'invitation.rejected' },
    });
  });

  it("is usable from dispatch until its expiry, then expired (the Market's lifetime)", () => {
    const invitation = dispatched();
    const expiry = NOW.add({ minutes: lifetimeMinutes });
    expect(invitation.state.expiresAt).toEqual(expiry);
    expect(invitation.usableAt(expiry.subtract({ seconds: 1 }))).toBe(true);
    expect(invitation.statusAt(expiry)).toBe('expired');
    expect(invitation.usableAt(expiry)).toBe(false);
    expect(invitation.accept(ACCOUNT_ID, expiry).ok).toBe(false);
  });

  it('a re-send replaces the token and the expiry (3.4 pending → pending)', () => {
    const invitation = dispatched();
    const later = NOW.add({ hours: 1 });
    expect(invitation.dispatch(OTHER_HASH, later, lifetimeMinutes).ok).toBe(true);
    expect(invitation.state.tokenHash).toEqual(OTHER_HASH);
    expect(invitation.state.expiresAt).toEqual(later.add({ minutes: lifetimeMinutes }));
  });

  it('is accepted once, and the address leaves with the decision (data design 4)', () => {
    const invitation = dispatched();
    const at = NOW.add({ minutes: 5 });
    expect(invitation.accept(ACCOUNT_ID, at)).toEqual({ ok: true, value: undefined });
    expect(invitation.state).toMatchObject({
      state: 'accepted',
      decidedAt: at,
      acceptedAccountId: ACCOUNT_ID,
      email: null,
      displayName: null,
    });
    expect(invitation.statusAt(at)).toBe('accepted');
    expect(invitation.accept(ACCOUNT_ID, at).ok).toBe(false);
    expect(invitation.revoke(at).ok).toBe(false);
    expect(invitation.dispatch(OTHER_HASH, at, lifetimeMinutes).ok).toBe(false);
  });

  it('is revoked from pending, expired included, and is then never usable', () => {
    const invitation = dispatched();
    const late = NOW.add({ minutes: lifetimeMinutes + 1 });
    expect(invitation.revoke(late).ok).toBe(true);
    expect(invitation.state).toMatchObject({ state: 'revoked', email: null, decidedAt: late });
    expect(invitation.accept(ACCOUNT_ID, NOW).ok).toBe(false);
  });

  it('names the invitee only on a seller-owner invitation, and needs a seller there', () => {
    const owner = Invitation.issue({
      id: INVITATION_ID,
      marketId,
      kind: 'seller-owner',
      email: email('owner@example.test'),
      displayName: 'Corner Grocer',
      roleId: ROLE_ID,
      sellerId: SELLER_ID,
      invitedByAccountId: ACCOUNT_ID,
      now: NOW,
    });
    expect(owner.state.displayName).toBe('Corner Grocer');
    owner.dispatch(HASH, NOW, lifetimeMinutes);
    owner.accept(ACCOUNT_ID, NOW);
    expect(owner.state.displayName).toBeNull();
  });

  it.each<[string, Partial<InvitationState>]>([
    ['an admin invitation with a seller', { sellerId: SELLER_ID }],
    ['a staff invitation without a seller', { kind: 'staff' }],
    ['a name on an admin invitation', { displayName: 'Someone' }],
    ['a seller-owner invitation without a name', { kind: 'seller-owner', sellerId: SELLER_ID }],
    [
      'a seller-owner name with a bidi control',
      { kind: 'seller-owner', sellerId: SELLER_ID, displayName: 'Shop\u202eOwner' },
    ],
    [
      'an untrimmed seller-owner name',
      { kind: 'seller-owner', sellerId: SELLER_ID, displayName: ' Shop Owner' },
    ],
    ['a token without an expiry', { tokenHash: HASH }],
    ['a pending invitation without an address', { email: null }],
    [
      'an accepted invitation without its account',
      { state: 'accepted', decidedAt: NOW, email: null },
    ],
    ['a pending invitation with a decision instant', { decidedAt: NOW }],
    ['version 0', { version: 0 }],
  ])('never builds %s', (_name, change) => {
    expect(() => Invitation.restore({ ...admin().state, ...change })).toThrow(
      InvitationInvariantError,
    );
  });

  it('refuses a short hash or a lifetime that is not a positive whole number', () => {
    const invitation = admin();
    expect(() => invitation.dispatch(new Uint8Array(31), NOW, lifetimeMinutes)).toThrow(RangeError);
    expect(() => invitation.dispatch(HASH, NOW, 0)).toThrow(RangeError);
    expect(() => invitation.dispatch(HASH, NOW, 1.5)).toThrow(RangeError);
  });
});

// Each fixture Market has its own policy (AU five attempts in five minutes, ZZ three in two).
describe.each([
  ['AU', { maxAttempts: 5, lifetimeSeconds: 300 }],
  ['ZZ', { maxAttempts: 3, lifetimeSeconds: 120 }],
] as const)('SignInChallenge in market %s (identity design 2.1, 6.3)', (code, policy) => {
  const marketId = market(code);
  const challenge = () =>
    issueChallenge({
      id: CHALLENGE_ID,
      marketId,
      accountId: ACCOUNT_ID,
      purpose: 'second-factor',
      credentialChangedAt: NOW.subtract({ hours: 2 }),
      policy,
      now: NOW,
    });

  it('opens with no attempt and an expiry from the policy', () => {
    expect(challenge()).toMatchObject({
      attempts: 0,
      consumedAt: null,
      createdAt: NOW,
      expiresAt: NOW.add({ seconds: policy.lifetimeSeconds }),
    });
  });

  it('is open for its purpose, below the limit and before the expiry only', () => {
    const open = challenge();
    expect(challengeIsOpen(open, 'second-factor', policy, NOW)).toBe(true);
    expect(challengeIsOpen(open, 'second-factor-enrolment', policy, NOW)).toBe(false);
    expect(challengeIsOpen(open, 'second-factor', policy, open.expiresAt)).toBe(false);
    expect(
      challengeIsOpen({ ...open, attempts: policy.maxAttempts }, 'second-factor', policy, NOW),
    ).toBe(false);
    expect(
      challengeIsOpen({ ...open, attempts: policy.maxAttempts - 1 }, 'second-factor', policy, NOW),
    ).toBe(true);
    expect(challengeIsOpen({ ...open, consumedAt: NOW }, 'second-factor', policy, NOW)).toBe(false);
  });

  it('belongs to the credential it was issued for (HF11)', () => {
    const open = challenge();
    expect(challengeMatchesCredential(open, NOW.subtract({ hours: 2 }))).toBe(true);
    expect(challengeMatchesCredential(open, NOW)).toBe(false);
  });

  it('refuses a policy that cannot hold', () => {
    for (const broken of [
      { maxAttempts: 0, lifetimeSeconds: 300 },
      { maxAttempts: 5, lifetimeSeconds: 0 },
      { maxAttempts: 1.5, lifetimeSeconds: 300 },
    ]) {
      expect(() =>
        issueChallenge({
          id: CHALLENGE_ID,
          marketId,
          accountId: ACCOUNT_ID,
          purpose: 'second-factor',
          credentialChangedAt: NOW,
          policy: broken,
          now: NOW,
        }),
      ).toThrow(ChallengePolicyError);
    }
  });
});
