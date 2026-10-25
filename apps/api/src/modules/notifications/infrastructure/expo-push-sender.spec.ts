import type { ExpoPushToken, OfferPush } from '../domain/push-device';
import { DisabledPushSender, EXPO_PUSH_URL, ExpoPushSender } from './expo-push-sender';
import { expoAccessToken } from './notifications-secrets';
import type { FetchLike } from './twilio-sms-sender';

const A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]' as ExpoPushToken;
const B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]' as ExpoPushToken;
const PUSH: OfferPush = {
  title: 'New offer',
  body: 'New offer, expires in 40 s',
  data: { kind: 'offer', offerId: '0195f000-0000-7000-8000-0000000000f1' },
  ttlSeconds: 40,
};

function answering(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchImpl };
}

describe('the Expo push sender', () => {
  it('posts one message per token to Expo, expiring with the offer, with the access token', async () => {
    const { calls, fetchImpl } = answering(200, {
      data: [
        { status: 'ok', id: 'x' },
        { status: 'ok', id: 'y' },
      ],
    });
    const tickets = await new ExpoPushSender('a'.repeat(40), fetchImpl).send([A, B], PUSH);
    expect(tickets).toEqual([{ ok: true }, { ok: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPO_PUSH_URL);
    expect(calls[0]!.init.redirect).toBe('error');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${'a'.repeat(40)}`,
    );
    const sent = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>[];
    expect(sent).toEqual([
      expect.objectContaining({
        to: A,
        title: PUSH.title,
        body: PUSH.body,
        data: PUSH.data,
        ttl: 40,
        priority: 'high',
      }),
      expect.objectContaining({ to: B }),
    ]);
  });

  it('drops an unregistered device, retries a rate limit and gives up on the rest', async () => {
    const { fetchImpl } = answering(200, {
      data: [
        { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } },
        { status: 'error', message: 'x', details: { error: 'MessageTooBig' } },
      ],
    });
    const tickets = await new ExpoPushSender(null, fetchImpl).send([A, B, A], PUSH);
    expect(tickets).toEqual([
      { ok: false, errorCode: 'push.DeviceNotRegistered', retryable: false, deviceGone: true },
      { ok: false, errorCode: 'push.MessageRateExceeded', retryable: true, deviceGone: false },
      { ok: false, errorCode: 'push.MessageTooBig', retryable: false, deviceGone: false },
    ]);
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
    [401, false],
  ])('answers HTTP %i as one failure per token (retryable: %s)', async (status, retryable) => {
    const { fetchImpl } = answering(status, { errors: [{ code: 'X' }] });
    const tickets = await new ExpoPushSender(null, fetchImpl).send([A, B], PUSH);
    expect(tickets).toEqual([
      { ok: false, errorCode: `push.expo-${status}`, retryable, deviceGone: false },
      { ok: false, errorCode: `push.expo-${status}`, retryable, deviceGone: false },
    ]);
  });

  it('retries a network failure and a malformed answer, sending no access header without a token', async () => {
    const down = await new ExpoPushSender(null, () => Promise.reject(new Error('down'))).send(
      [A],
      PUSH,
    );
    expect(down).toEqual([
      { ok: false, errorCode: 'push.network', retryable: true, deviceGone: false },
    ]);
    const { calls, fetchImpl } = answering(200, { data: [] });
    const short = await new ExpoPushSender(null, fetchImpl).send([A], PUSH);
    expect(short[0]).toMatchObject({ ok: false, retryable: true });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('never pushes while disabled', async () => {
    expect(await new DisabledPushSender().send([A])).toEqual([
      { ok: false, errorCode: 'push.disabled', retryable: false, deviceGone: false },
    ]);
  });

  it('reads EXPO_ACCESS_TOKEN', () => {
    expect(expoAccessToken({})).toBeNull();
    expect(expoAccessToken({ EXPO_ACCESS_TOKEN: '' })).toBeNull();
    expect(expoAccessToken({ EXPO_ACCESS_TOKEN: 'a'.repeat(40) })).toBe('a'.repeat(40));
    expect(() => expoAccessToken({ EXPO_ACCESS_TOKEN: 'short' })).toThrow('EXPO_ACCESS_TOKEN');
  });
});
