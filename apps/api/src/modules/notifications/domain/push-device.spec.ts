import { Temporal } from '@mondapac-drive/shared-kernel';
import { notificationSettings } from '../../../../test/support/notifications-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  isLivePushDevice,
  offerPush,
  parseExpoPushToken,
  registerPushDevice,
  type ExpoPushToken,
} from './push-device';

const NOW = Temporal.Instant.from('2026-11-02T00:00:00Z');
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' as ExpoPushToken;
const OFFER = '0195f000-0000-7000-8000-0000000000f1';

describe('push device rules', () => {
  it.each(['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', 'ExpoPushToken[AbCdEf0123456789_-AbCd]'])(
    'takes the Expo token %s',
    (raw) => {
      expect(parseExpoPushToken(raw)).toBe(raw);
    },
  );

  it.each([
    ['an FCM token', 'fcm:' + 'a'.repeat(140)],
    ['a short id', 'ExponentPushToken[abc]'],
    ['no brackets', 'ExponentPushToken xxxxxxxxxxxxxxxxxxxxxx'],
    ['a trailing payload', 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]\n'],
    ['a URL inside', 'ExponentPushToken[https://evil.example/xxxxxxxx]'],
    ['an empty string', ''],
  ])('refuses %s', (_name, raw) => {
    expect(parseExpoPushToken(raw)).toBeUndefined();
  });

  it('lives until the session could end, then no longer', () => {
    const device = registerPushDevice(
      { id: 'd', accountId: 'a', sessionId: 's', platform: 'ios', token: TOKEN },
      NOW,
      3600,
    );
    expect(device.expiresAt).toEqual(NOW.add({ seconds: 3600 }));
    expect(isLivePushDevice(device, NOW.add({ seconds: 3599 }))).toBe(true);
    expect(isLivePushDevice(device, NOW.add({ seconds: 3600 }))).toBe(false);
  });

  it('refuses a lifetime below one second', () => {
    const device = { id: 'd', accountId: 'a', sessionId: 's', platform: 'android', token: TOKEN };
    expect(() => registerPushDevice(device as never, NOW, 0)).toThrow('at least one second');
  });
});

describe.each(TEST_MARKET_IDS)('the offer push in %s', (marketId) => {
  const text = notificationSettings.get(marketId).offerPush;

  it('names the seconds left and the offer id only, and expires with the offer', () => {
    const push = offerPush(text, OFFER, NOW.add({ seconds: 45, milliseconds: 900 }), NOW)!;
    expect(push.body).toContain('45');
    expect(push.body).not.toContain('{seconds}');
    expect(push.title).toBe(text.title);
    expect(push.data).toEqual({ kind: 'offer', offerId: OFFER });
    expect(push.ttlSeconds).toBe(45);
  });

  it.each([
    ['expired', -5_000],
    ['expiring now', 0],
    ['with less than a second left', 999],
  ])('is not sent for an offer %s', (_name, milliseconds) => {
    expect(offerPush(text, OFFER, NOW.add({ milliseconds }), NOW)).toBeUndefined();
  });
});
