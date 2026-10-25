import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { ApiError } from '../src/api/client';
import { createHttpCourierApi, ROUTES } from '../src/api/http-client';
import type { PushDevice } from '../src/api/schemas';
import { devicePush } from '../src/push/device-push';
import { offerIdOf, onceEach, type PushService } from '../src/push/push-service';
import { HomeScreen, OFFER_POLL_MS, OFFER_POLL_PUSH_MS } from '../src/screens/HomeScreen';
import { MARKETS } from './markets';
import { createHarness, renderWith, type Harness } from './render';

const DEVICE: PushDevice = { token: 'ExponentPushToken[abc123]', platform: 'android' };

function fakePush(device: PushDevice | null = DEVICE) {
  let listener: ((offerId: string) => void) | null = null;
  const push = {
    deviceToken: jest.fn(() => Promise.resolve(device)),
    onOffer: jest.fn((next: (offerId: string) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  } satisfies PushService;
  return { push, deliver: (offerId: string) => listener?.(offerId) };
}

async function renderHome(harness: Harness, push: PushService) {
  const handlers = {
    onOpenJob: jest.fn(),
    onOpenEarnings: jest.fn(),
    onNeedLocation: jest.fn(),
    onOfferPush: jest.fn(),
  };
  await renderWith(harness, <HomeScreen {...handlers} push={push} />);
  await screen.findByText('You are offline');
  return handlers;
}

describe('offer push data', () => {
  it('reads the offer id of an offer push and nothing else', () => {
    expect(offerIdOf({ kind: 'offer', offerId: 'o-1' })).toBe('o-1');
    expect(offerIdOf({ kind: 'offer', offerId: '../x' })).toBeNull();
    expect(offerIdOf({ kind: 'other', offerId: 'o-1' })).toBeNull();
    expect(offerIdOf({ kind: 'offer' })).toBeNull();
    expect(offerIdOf(null)).toBeNull();
    expect(offerIdOf('offer')).toBeNull();
  });

  it('acts on each offer once, even when the push arrives twice', () => {
    const first = onceEach(2);
    expect([first('a'), first('a'), first('b'), first('c'), first('a')]).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe.each(MARKETS)('offer pushes in $marketId', (settings) => {
  it('registers the device after sign-in and again when the app comes back', async () => {
    let onChange: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, next) => {
      onChange = next;
      return { remove: jest.fn() };
    });
    const harness = await createHarness({ settings });
    const register = jest.spyOn(harness.api, 'registerPushDevice');
    const { push } = fakePush();
    await renderHome(harness, push);
    await waitFor(() => expect(harness.mock.inspect.pushDevice()).toEqual(DEVICE));
    expect(register).toHaveBeenCalledTimes(1);

    await act(() => onChange?.('background'));
    await act(() => onChange?.('active'));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
  });

  it('fetches the offer when a push arrives, once per offer', async () => {
    const harness = await createHarness({ settings });
    const { push, deliver } = fakePush();
    const handlers = await renderHome(harness, push);
    await fireEvent.press(screen.getByRole('button', { name: 'Go online' }));
    await screen.findByText('New delivery offer');
    const fetchOffer = jest.spyOn(harness.api, 'currentOffer');

    await act(() => deliver('mock-offer-1'));
    await act(() => deliver('mock-offer-1'));
    expect(handlers.onOfferPush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchOffer).toHaveBeenCalledTimes(1));
  });
});

it('stops pushes before the session ends on sign-out', async () => {
  const harness = await createHarness();
  const { push } = fakePush();
  await renderHome(harness, push);
  await waitFor(() => expect(harness.mock.inspect.pushDevice()).toEqual(DEVICE));
  const order: string[] = [];
  jest.spyOn(harness.api, 'removePushDevice').mockImplementation(() => {
    order.push('remove');
    return Promise.resolve();
  });
  const signOut = jest.spyOn(harness.api, 'signOut');
  signOut.mockImplementation(() => {
    order.push('sign-out');
    return Promise.resolve();
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(harness.stored()).toBeNull());
  expect(order).toEqual(['remove', 'sign-out']);
});

it('signs out even when the device cannot be removed', async () => {
  const harness = await createHarness();
  const { push } = fakePush();
  await renderHome(harness, push);
  jest
    .spyOn(harness.api, 'removePushDevice')
    .mockRejectedValue(new ApiError(0, 'network.unavailable'));
  await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(harness.stored()).toBeNull());
});

describe('polling as the fallback', () => {
  async function pollsIn(device: PushDevice | null, ms: number): Promise<number> {
    jest.useFakeTimers();
    try {
      const harness = await createHarness();
      const { push } = fakePush(device);
      await renderHome(harness, push);
      await fireEvent.press(screen.getByRole('button', { name: 'Go online' }));
      await screen.findByText('New delivery offer');
      if (device) await waitFor(() => expect(harness.mock.inspect.pushDevice()).toEqual(device));
      const fetchOffer = jest.spyOn(harness.api, 'currentOffer');
      await act(() => jest.advanceTimersByTimeAsync(ms));
      return fetchOffer.mock.calls.length;
    } finally {
      jest.useRealTimers();
    }
  }

  it(`polls every ${OFFER_POLL_MS} ms without push and every ${OFFER_POLL_PUSH_MS} ms with it`, async () => {
    expect(await pollsIn(null, 20_000)).toBeGreaterThanOrEqual(3);
    expect(await pollsIn(DEVICE, 20_000)).toBe(0);
  });
});

describe('the HTTP adapter', () => {
  const session = { token: 'token-0123456789abcdef', marketId: 'ZZ' };
  function setup() {
    const fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const api = createHttpCourierApi({
      baseUrl: 'https://api.example.test',
      session: { current: () => session },
      marketId: 'ZZ',
      fetch,
    });
    return { api, fetch };
  }

  it('puts the device and deletes it on the notifications route', async () => {
    const { api, fetch } = setup();
    await api.registerPushDevice(DEVICE);
    await api.removePushDevice();
    const [[putUrl, put], [deleteUrl, del]] = fetch.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(putUrl).toBe(`https://api.example.test${ROUTES.pushDevice}`);
    expect(put.method).toBe('PUT');
    expect(JSON.parse(put.body as string)).toEqual(DEVICE);
    expect(deleteUrl).toBe(putUrl);
    expect(del.method).toBe('DELETE');
    expect(del.body).toBeUndefined();
  });

  it('never sends a token that is not an Expo push token', async () => {
    const { api, fetch } = setup();
    await expect(
      api.registerPushDevice({ token: 'raw-fcm-token', platform: 'android' }),
    ).rejects.toEqual(new ApiError(400, 'push-device.invalid-token'));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the Expo adapter', () => {
  const mocked = jest.mocked(Notifications);

  it('has no token when the courier refuses notifications', async () => {
    mocked.getPermissionsAsync.mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    } as never);
    mocked.requestPermissionsAsync.mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
    } as never);
    await expect(devicePush.deviceToken()).resolves.toBeNull();
    expect(mocked.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("returns Expo's token with the platform once allowed, and nothing on a simulator", async () => {
    mocked.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
    mocked.getExpoPushTokenAsync.mockResolvedValueOnce({
      type: 'expo',
      data: 'ExponentPushToken[device-1]',
    });
    const device = await devicePush.deviceToken();
    expect(device?.token).toBe('ExponentPushToken[device-1]');
    expect(['ios', 'android']).toContain(device?.platform);

    mocked.getExpoPushTokenAsync.mockRejectedValueOnce(new Error('simulator'));
    await expect(devicePush.deviceToken()).resolves.toBeNull();
  });

  it('passes on offer pushes, received or tapped, and ignores the rest', () => {
    const listener = jest.fn();
    const unsubscribe = devicePush.onOffer(listener);
    const received = mocked.addNotificationReceivedListener.mock.calls.at(-1)![0];
    const tapped = mocked.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
    const notification = (data: object) =>
      ({ request: { content: { data } } }) as unknown as Notifications.Notification;
    received(notification({ kind: 'offer', offerId: 'o-1' }));
    tapped({ notification: notification({ kind: 'offer', offerId: 'o-2' }) } as never);
    received(notification({ kind: 'news' }));
    expect(listener.mock.calls).toEqual([['o-1'], ['o-2']]);
    unsubscribe();
  });

  it('handles the tap that opened the app once, then clears it', () => {
    const notification = { request: { content: { data: { kind: 'offer', offerId: 'o-9' } } } };
    mocked.getLastNotificationResponse.mockReturnValueOnce({ notification } as never);
    const listener = jest.fn();
    devicePush.onOffer(listener)();
    expect(listener).toHaveBeenCalledWith('o-9');
    expect(mocked.clearLastNotificationResponse).toHaveBeenCalled();
  });
});
