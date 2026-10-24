import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { OneTimeLink, type OneTimeLinkState } from './one-time-link';

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

const LINK_ID = id<'OneTimeLink'>('01990000-0000-7000-8000-0000000000a1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

// Each fixture Market has its own lifetime (AU 24 hours, ZZ 12): nothing assumes AU's.
describe.each([
  ['AU', 1440],
  ['ZZ', 720],
] as const)('OneTimeLink in market %s (identity design 3.7)', (code, lifetimeMinutes) => {
  const marketId = market(code);
  const request = (notify = true) =>
    OneTimeLink.request({
      id: LINK_ID,
      marketId,
      accountId: ACCOUNT_ID,
      purpose: 'enrol-second-factor',
      now: NOW,
      notify,
    });
  const issued = () => {
    const link = OneTimeLink.restore(request().state);
    expect(link.issue(HASH, NOW, lifetimeMinutes)).toEqual({ ok: true, value: undefined });
    return OneTimeLink.restore(link.state);
  };
  const expiry = NOW.add({ minutes: lifetimeMinutes });

  it('is requested without a token, version 1, and records the request when the mail may go', () => {
    const link = request();

    expect(link.state).toEqual<OneTimeLinkState>({
      id: LINK_ID,
      marketId,
      accountId: ACCOUNT_ID,
      purpose: 'enrol-second-factor',
      requestedAt: NOW,
      tokenHash: null,
      issuedAt: null,
      expiresAt: null,
      consumedAt: null,
      version: 1,
    });
    expect(link.statusAt(NOW)).toBe('requested');
    expect(link.pendingEvents).toEqual([
      expect.objectContaining({
        type: 'identity.one-time-link-requested.v1',
        aggregateType: 'one-time-link',
        aggregateId: LINK_ID,
        aggregateVersion: 1,
        payload: { linkId: LINK_ID, accountId: ACCOUNT_ID, purpose: 'enrol-second-factor' },
      }),
    ]);
  });

  it('records no event when the mail counters refused the mail (Mojtaba item 3)', () => {
    expect(request(false).pendingEvents).toEqual([]);
  });

  it('is issued once, from requested, with the expiry the Market sets', () => {
    const link = issued();

    expect(link.state).toMatchObject({ issuedAt: NOW, expiresAt: expiry, version: 2 });
    expect(link.state.tokenHash).toEqual(HASH);
    expect(link.statusAt(NOW)).toBe('issued');
    expect(link.issue(OTHER_HASH, NOW, lifetimeMinutes)).toEqual({
      ok: false,
      error: { code: 'link.rejected' },
    });
    expect(link.pendingEvents).toEqual([]);
  });

  it('is usable until just before its expiry, and expired from it', () => {
    const link = issued();

    expect(link.usableFor('enrol-second-factor', expiry.subtract({ milliseconds: 1 }))).toBe(true);
    expect(link.usableFor('enrol-second-factor', expiry)).toBe(false);
    expect(link.statusAt(expiry)).toBe('expired');
    expect(link.usableFor('reset-password', NOW)).toBe(false);
  });

  it('is consumed once', () => {
    const link = issued();

    expect(link.consume(NOW.add({ minutes: 1 })).ok).toBe(true);
    expect(link.statusAt(NOW.add({ minutes: 2 }))).toBe('consumed');
    expect(link.consume(NOW.add({ minutes: 2 }))).toEqual({
      ok: false,
      error: { code: 'link.rejected' },
    });
    expect(link.state.version).toBe(3);
  });

  it('refuses a requested or expired link', () => {
    expect(request().consume(NOW).ok).toBe(false);
    expect(issued().consume(expiry).ok).toBe(false);
  });

  it('a new request voids the earlier token and records the request again', () => {
    const link = issued();
    const later = NOW.add({ minutes: 5 });

    link.requestAgain(later, true);

    expect(link.state).toMatchObject({
      requestedAt: later,
      tokenHash: null,
      issuedAt: null,
      expiresAt: null,
      consumedAt: null,
      version: 3,
    });
    expect(link.statusAt(later)).toBe('requested');
    expect(link.pendingEvents).toEqual([
      expect.objectContaining({ aggregateVersion: 3, occurredAt: later }),
    ]);
  });

  it('a new request without the mail still voids the token, with no event', () => {
    const link = issued();

    link.requestAgain(NOW.add({ minutes: 5 }), false);

    expect(link.state.tokenHash).toBeNull();
    expect(link.state.version).toBe(3);
    expect(link.pendingEvents).toEqual([]);
  });

  it('refuses a hash that is not 32 bytes or a lifetime that is not a positive whole number', () => {
    expect(() => request().issue(new Uint8Array(16), NOW, lifetimeMinutes)).toThrow(RangeError);
    expect(() => request().issue(HASH, NOW, 0)).toThrow(RangeError);
  });
});
