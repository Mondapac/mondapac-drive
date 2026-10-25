import { ok, parseId, Temporal, type Clock, type Id } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { notificationSettings } from '../../../../../test/support/notifications-markets';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { UuidV7IdGenerator } from '../../../../platform/ids/uuid-v7-id-generator';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  isLivePushDevice,
  type ExpoPushToken,
  type OfferPush,
  type PushDevice,
} from '../../domain/push-device';
import type { PushDeviceRepository, PushSender, PushTicket } from '../ports';
import { ForgetPushDevices, RegisterPushDevice, RemovePushDevice } from './push-devices.use-case';
import { SendOfferPush } from './send-offer-push.use-case';

const NOW = Temporal.Instant.from('2026-11-02T00:00:00Z');
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const OFFER = '0195f000-0000-7000-8000-0000000000f1';

const id = (n: number): Id => {
  const parsed = parseId(`0195f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

class TestClock implements Clock {
  instant = NOW;
  now() {
    return this.instant;
  }
}

/** The repository's rules in memory: one device per session, one session per token. */
class InMemoryDevices implements PushDeviceRepository {
  rows: PushDevice[] = [];
  save(_market: unknown, device: PushDevice) {
    this.rows = this.rows.filter(
      (row) => row.sessionId !== device.sessionId && row.token !== device.token,
    );
    this.rows.push(device);
    return Promise.resolve();
  }
  removeOfSession(_market: unknown, accountId: string, sessionId: string) {
    return this.drop((row) => row.accountId === accountId && row.sessionId === sessionId);
  }
  removeOfAccount(_market: unknown, accountId: string) {
    return this.drop((row) => row.accountId === accountId);
  }
  removeByIds(_market: unknown, ids: readonly string[]) {
    return this.drop((row) => ids.includes(row.id));
  }
  liveOf(_market: unknown, accountId: string, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      this.rows
        .filter((row) => row.accountId === accountId && isLivePushDevice(row, now))
        .slice(0, limit),
    );
  }
  private drop(match: (row: PushDevice) => boolean) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !match(row));
    return Promise.resolve(before - this.rows.length);
  }
}

class ScriptedSender implements PushSender {
  readonly sent: { to: readonly ExpoPushToken[]; push: OfferPush }[] = [];
  answers = new Map<string, PushTicket>();
  send(to: readonly ExpoPushToken[], push: OfferPush) {
    this.sent.push({ to, push });
    return Promise.resolve(to.map((token) => this.answers.get(token) ?? { ok: true as const }));
  }
}

describe.each(TEST_MARKET_IDS)('courier push in %s', (marketId) => {
  const market = testMarketContext(marketId, 'default');
  const courier = (account: number, session: number) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'courier',
        accountId: id(account) as never,
        sessionId: id(session) as never,
        merchantId: null,
      }),
      'push-courier-0001',
    );
  const system = testCallContext(market, 'system', 'push-system-0001');
  const settings = notificationSettings;
  const lifetime = settings.get(marketId).pushDeviceLifetimeSeconds;

  function wired() {
    const clock = new TestClock();
    const devices = new InMemoryDevices();
    const sender = new ScriptedSender();
    const unitOfWork = {
      run: (_market: unknown, work: () => Promise<unknown>) => work(),
      runOnce: fakeRunOnce(),
    } as unknown as UnitOfWork;
    const gate = openGate();
    const ids = new UuidV7IdGenerator(clock);
    return {
      clock,
      devices,
      sender,
      register: new RegisterPushDevice(gate, { devices, settings, unitOfWork, ids, clock }),
      remove: new RemovePushDevice(gate, { devices, unitOfWork }),
      forget: new ForgetPushDevices(gate, { devices, unitOfWork }),
      push: new SendOfferPush(gate, { devices, sender, settings, unitOfWork, clock }),
    };
  }
  let serial = 0;
  const delivery = (subscriber = 'notifications.offer-push'): EventDelivery => ({
    eventId: id(0xe000 + ++serial) as Id<'event'>,
    subscriber,
    attempt: 1,
  });

  it("registers the session's device for the session's lifetime, once per session and token", async () => {
    const { register, devices } = wired();
    expect(await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' })).toEqual(
      ok(undefined),
    );
    expect(devices.rows).toEqual([
      expect.objectContaining({
        accountId: id(1),
        sessionId: id(11),
        platform: 'ios',
        token: TOKEN_A,
        expiresAt: NOW.add({ seconds: lifetime }),
      }),
    ]);
    await register.execute(courier(1, 11), { token: TOKEN_B, platform: 'ios' });
    expect(devices.rows.map((row) => row.token)).toEqual([TOKEN_B]);
    // The same phone signed in again under a new session: the token moves.
    await register.execute(courier(1, 12), { token: TOKEN_B, platform: 'ios' });
    expect(devices.rows.map((row) => row.sessionId)).toEqual([id(12)]);
  });

  it('refuses a token that is not an Expo push token, and every caller but a courier', async () => {
    const { register, remove, devices } = wired();
    expect(
      await register.execute(courier(1, 11), { token: 'fcm:abc', platform: 'android' }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'push-device.invalid-token' }) as unknown,
    });
    const merchant = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'merchant',
        accountId: id(2) as never,
        sessionId: id(22) as never,
        merchantId: id(222) as never,
      }),
      'push-merchant-0001',
    );
    for (const context of [merchant, system]) {
      expect(await register.execute(context, { token: TOKEN_A, platform: 'ios' })).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'access.denied' }) as unknown,
      });
      expect(await remove.execute(context, {})).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'access.denied' }) as unknown,
      });
    }
    expect(devices.rows).toEqual([]);
  });

  it("drops only the session's own device on sign-out", async () => {
    const { register, remove, devices } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    await register.execute(courier(1, 12), { token: TOKEN_B, platform: 'android' });
    expect(await remove.execute(courier(1, 11), {})).toEqual(ok(undefined));
    expect(await remove.execute(courier(1, 11), {})).toEqual(ok(undefined));
    expect(await remove.execute(courier(3, 12), {})).toEqual(ok(undefined));
    expect(devices.rows.map((row) => row.sessionId)).toEqual([id(12)]);
  });

  it('drops every device of an account whose sessions identity ended, once per event', async () => {
    const { register, forget, devices } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    await register.execute(courier(1, 12), { token: TOKEN_B, platform: 'android' });
    const event = delivery('notifications.signed-out-sessions');
    expect(await forget.execute(system, { delivery: event, accountId: id(1) })).toEqual(
      ok({ removed: 2 }),
    );
    expect(devices.rows).toEqual([]);
    expect(await forget.execute(system, { delivery: event, accountId: id(1) })).toEqual(
      ok({ removed: 0 }),
    );
  });

  it("pushes a new offer to the courier's live devices with the offer id only", async () => {
    const { register, push, sender, clock } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    await register.execute(courier(5, 51), { token: TOKEN_B, platform: 'ios' });
    clock.instant = NOW.add({ seconds: 10 });
    const outcome = await push.execute(system, {
      delivery: delivery(),
      offerId: OFFER,
      courierId: id(1),
      expiresAt: NOW.add({ seconds: 70 }),
    });
    expect(outcome).toEqual(ok({ pushed: 1, dropped: 0 }));
    expect(sender.sent).toEqual([
      {
        to: [TOKEN_A],
        push: {
          title: settings.get(marketId).offerPush.title,
          body: settings.get(marketId).offerPush.body.replace('{seconds}', '60'),
          data: { kind: 'offer', offerId: OFFER },
          ttlSeconds: 60,
        },
      },
    ]);
  });

  it('skips an expired offer, a courier without a device, a device past its lifetime and a repeat', async () => {
    const { register, push, sender, clock } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    const input = (expiresAt: Temporal.Instant, courierId = id(1)) => ({
      delivery: delivery(),
      offerId: OFFER,
      courierId,
      expiresAt,
    });
    expect(await push.execute(system, input(NOW))).toEqual(ok({ skipped: 'expired' }));
    expect(await push.execute(system, input(NOW.add({ seconds: 30 }), id(9)))).toEqual(
      ok({ skipped: 'no-device' }),
    );
    const once = input(NOW.add({ seconds: 30 }));
    expect(await push.execute(system, once)).toEqual(ok({ pushed: 1, dropped: 0 }));
    expect(await push.execute(system, once)).toEqual(ok({ skipped: 'handled' }));
    clock.instant = NOW.add({ seconds: lifetime });
    expect(await push.execute(system, input(clock.instant.add({ seconds: 30 })))).toEqual(
      ok({ skipped: 'no-device' }),
    );
    expect(sender.sent).toHaveLength(2);
  });

  it('drops a device the push service no longer knows, and retries when nothing went out', async () => {
    const { register, push, sender, devices } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    await register.execute(courier(1, 12), { token: TOKEN_B, platform: 'android' });
    sender.answers.set(TOKEN_A, {
      ok: false,
      errorCode: 'push.DeviceNotRegistered',
      retryable: false,
      deviceGone: true,
    });
    sender.answers.set(TOKEN_B, {
      ok: false,
      errorCode: 'push.expo-503',
      retryable: true,
      deviceGone: false,
    });
    const event = delivery();
    const input = {
      delivery: event,
      offerId: OFFER,
      courierId: id(1),
      expiresAt: NOW.add({ seconds: 30 }),
    };
    expect(await push.execute(system, input)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'push.unavailable' }) as unknown,
    });
    expect(devices.rows.map((row) => row.token)).toEqual([TOKEN_B]);
    sender.answers.delete(TOKEN_B);
    expect(await push.execute(system, input)).toEqual(ok({ pushed: 1, dropped: 0 }));
  });

  it('gives up on a failure that will not pass', async () => {
    const { register, push, sender } = wired();
    await register.execute(courier(1, 11), { token: TOKEN_A, platform: 'ios' });
    sender.answers.set(TOKEN_A, {
      ok: false,
      errorCode: 'push.disabled',
      retryable: false,
      deviceGone: false,
    });
    expect(
      await push.execute(system, {
        delivery: delivery(),
        offerId: OFFER,
        courierId: id(1),
        expiresAt: NOW.add({ seconds: 30 }),
      }),
    ).toEqual(ok({ pushed: 0, dropped: 0 }));
  });

  it('is the system actor’s only', async () => {
    const { push, forget } = wired();
    await expectSystemOnly(marketId as 'AU' | 'ZZ', (context) =>
      push.execute(context, {
        delivery: delivery(),
        offerId: OFFER,
        courierId: id(1),
        expiresAt: NOW.add({ seconds: 30 }),
      }),
    );
    await expectSystemOnly(marketId as 'AU' | 'ZZ', (context) =>
      forget.execute(context, { delivery: delivery(), accountId: id(1) }),
    );
  });
});
