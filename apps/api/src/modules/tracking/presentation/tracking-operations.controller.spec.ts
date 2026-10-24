import type { IncomingMessage } from 'node:http';
import { err, ok, type CallContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { lastValueFrom, toArray } from 'rxjs';
import type { Authenticator } from '../../../platform/authz';
import type { DeliveryTrail } from '../application/use-cases/delivery-trail.use-case';
import type {
  ViewCourierPosition,
  ViewNearbyCouriers,
} from '../application/use-cases/view-courier-positions.use-case';
import { AdminSessionCheck } from './admin-session-check';
import { DispatcherTrackingController } from './tracking-operations.controller';

// The dispatcher map's stream slots (security review of 06b, M1): a client that leaves while the
// first read runs, before Nest subscribes, never keeps a slot. And its session (L1): each later
// event re-checks the admin's session, so a sign-out or a revoked session ends the stream.

const market = testMarketContext('ZZ', 'platform');
const admin: CallContext = testCallContext(
  market,
  testAuthenticatedActor(market, {
    population: 'admin',
    accountId: '01990000-0000-7000-8000-0000000000a1' as never,
    sessionId: '01990000-0000-7000-8000-0000000001a1' as never,
    merchantId: null,
  }),
  'map-stream-0001',
);
const query = { lat: '-27.47', lng: '153.02', radiusM: '5000' };
const SESSION_TOKEN = 'a'.repeat(43);
const request = {
  headers: { cookie: `__Host-session-admin-ZZ=${SESSION_TOKEN}` },
} as unknown as IncomingMessage;

/** identity's Authenticator, answering the admin's session while `live` says so. */
function authenticator(live: () => boolean | 'throws'): Authenticator {
  return {
    authenticate: (_market, credential) => {
      const state = live();
      if (state === 'throws') return Promise.reject(new Error('database down'));
      const actor = admin.actor;
      return Promise.resolve(
        state && credential.token === SESSION_TOKEN && credential.transport === 'cookie'
          ? ok(actor as never)
          : err({ code: 'credential.rejected' as const }),
      );
    },
  };
}

function controller(live: () => boolean | 'throws' = () => true) {
  const nearby = { execute: () => Promise.resolve(ok([])) } as unknown as ViewNearbyCouriers;
  return new DispatcherTrackingController(
    nearby,
    {} as ViewCourierPosition,
    {} as DeliveryTrail,
    new AdminSessionCheck(authenticator(live)),
  );
}

describe('dispatcher map stream slots', () => {
  it('gives the slot back when the client left during the first read', async () => {
    const map = controller();
    for (let i = 0; i < 5; i += 1) {
      const gone = new AbortController();
      gone.abort();
      const stream = await map.map(admin, query, gone.signal, request);
      expect(await lastValueFrom(stream.pipe(toArray()))).toEqual([]);
    }
    // Still the three slots of the admin: a live client opens a stream.
    const live = new AbortController();
    await expect(map.map(admin, query, live.signal, request)).resolves.toBeDefined();
    live.abort();
  });

  it('refuses a fourth open stream of one admin, and frees a slot on abort', async () => {
    const map = controller();
    const open = [new AbortController(), new AbortController(), new AbortController()];
    for (const client of open) await map.map(admin, query, client.signal, request);
    await expect(
      map.map(admin, query, new AbortController().signal, request),
    ).rejects.toMatchObject({
      status: 429,
    });
    open[0]!.abort();
    await expect(
      map.map(admin, query, new AbortController().signal, request),
    ).resolves.toBeDefined();
    for (const client of open) client.abort();
  });
});

describe('dispatcher map stream session (security review of 06b, L1)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function eventsOf(live: () => boolean | 'throws', ticks: number) {
    const client = new AbortController();
    const stream = await controller(live).map(admin, query, client.signal, request);
    const events: unknown[] = [];
    let done = false;
    const subscription = stream.subscribe({
      next: (event) => events.push(event),
      complete: () => (done = true),
    });
    for (let i = 0; i < ticks; i += 1) await jest.advanceTimersByTimeAsync(5000);
    subscription.unsubscribe();
    client.abort();
    return { events, done };
  }

  it('keeps sending while the session is live', async () => {
    const { events, done } = await eventsOf(() => true, 3);
    expect(events).toHaveLength(4);
    expect(done).toBe(false);
  });

  it('ends with session.invalid on the first event after the session is revoked', async () => {
    let live = true;
    const client = new AbortController();
    const stream = await controller(() => live).map(admin, query, client.signal, request);
    const events: { type: string; data: unknown }[] = [];
    let done = false;
    stream.subscribe({
      next: (event) => events.push(event as never),
      complete: () => (done = true),
    });
    await jest.advanceTimersByTimeAsync(5000);
    live = false;
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(events.map((event) => event.type)).toEqual(['couriers', 'couriers', 'end']);
    expect(events[2]!.data).toEqual({ code: 'session.invalid' });
    expect(done).toBe(true);
    client.abort();
  });

  it('fails closed when the session check itself fails', async () => {
    let calls = 0;
    const { events, done } = await eventsOf(() => (++calls > 1 ? 'throws' : true), 2);
    expect(events).toEqual([
      expect.objectContaining({ type: 'couriers' }),
      expect.objectContaining({ type: 'couriers' }),
      { type: 'end', data: { code: 'session.invalid' } },
    ]);
    expect(done).toBe(true);
  });
});

describe('AdminSessionCheck', () => {
  const check = (live: () => boolean | 'throws') => new AdminSessionCheck(authenticator(live));

  it('answers true for the session the stream opened with', async () => {
    await expect(check(() => true).of(request, admin)()).resolves.toBe(true);
  });

  it('answers false for a rejected session, a failing check, or another session', async () => {
    await expect(check(() => false).of(request, admin)()).resolves.toBe(false);
    await expect(check(() => 'throws').of(request, admin)()).resolves.toBe(false);
    const otherSession = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: '01990000-0000-7000-8000-0000000000a1' as never,
        sessionId: '01990000-0000-7000-8000-0000000002a1' as never,
        merchantId: null,
      }),
      'map-stream-0002',
    );
    await expect(check(() => true).of(request, otherSession)()).resolves.toBe(false);
  });

  it('answers false without the admin cookie, with a repeated one, or for a non-admin', async () => {
    const none = { headers: {} } as unknown as IncomingMessage;
    const twice = {
      headers: { cookie: `__Host-session-admin-ZZ=${SESSION_TOKEN}; __Host-session-admin-ZZ=x` },
    } as unknown as IncomingMessage;
    await expect(check(() => true).of(none, admin)()).resolves.toBe(false);
    await expect(check(() => true).of(twice, admin)()).resolves.toBe(false);
    const system = testCallContext(market, 'system', 'map-stream-0003');
    await expect(check(() => true).of(request, system)()).resolves.toBe(false);
  });
});
