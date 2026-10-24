import { ApiError } from '../src/api/client';
import { createMockCourierApi } from '../src/api/mock/mock-client';
import { handleLocationUpdate, type TaskDeps } from '../src/location/background-task';
import { MAX_PINGS_PER_BATCH, toPings, type LocationFix } from '../src/location/pings';
import { fakeClock } from '../src/platform/clock/clock';

const fix = (overrides: Partial<LocationFix['coords']> = {}, timestamp = 1_761_296_400_000) => ({
  timestamp,
  coords: {
    latitude: -27.47,
    longitude: 153.02,
    accuracy: 8.4,
    heading: 90,
    speed: 10,
    ...overrides,
  },
});

describe('location pings', () => {
  it('maps a fix to the tracking ping', () => {
    expect(toPings('c-1', [fix()])).toEqual([
      {
        courierId: 'c-1',
        lat: -27.47,
        lng: 153.02,
        accuracyM: 8,
        headingDeg: 90,
        speedKmh: 36,
        recordedAt: new Date(1_761_296_400_000).toISOString(),
      },
    ]);
  });

  it('drops a fix without accuracy and leaves out unknown heading and speed', () => {
    const [ping, ...rest] = toPings('c-1', [
      fix({ accuracy: null }),
      fix({ heading: -1, speed: -1 }),
    ]);
    expect(rest).toEqual([]);
    expect(ping).not.toHaveProperty('headingDeg');
    expect(ping).not.toHaveProperty('speedKmh');
  });

  it('keeps the latest fixes of a burst', () => {
    const fixes = Array.from({ length: 50 }, (_, i) => fix({}, i * 1000));
    const pings = toPings('c-1', fixes);
    expect(pings).toHaveLength(MAX_PINGS_PER_BATCH);
    expect(pings.at(-1)?.recordedAt).toBe(new Date(49_000).toISOString());
  });
});

describe('background location task', () => {
  async function deps(online: boolean, signedIn = true) {
    const mock = createMockCourierApi({ clock: fakeClock(0) });
    const session = await mock.api.signIn({ phone: '+61400000000', code: '123456' });
    const stopUpdates = jest.fn(() => Promise.resolve());
    const clearSession = jest.fn(() => Promise.resolve());
    const value: TaskDeps = {
      api: () => mock.api,
      session: () => Promise.resolve(signedIn ? session : null),
      isOnline: () => Promise.resolve(online),
      stopUpdates,
      clearSession,
    };
    return { value, mock, stopUpdates, clearSession, session };
  }

  it('sends pings while the courier is online', async () => {
    const { value, mock, session } = await deps(true);
    await handleLocationUpdate({ data: { locations: [fix()] } }, value);
    expect(mock.inspect.pings()).toHaveLength(1);
    expect(mock.inspect.pings()[0]?.courierId).toBe(session.courierId);
  });

  it('sends nothing and stops the updates once offline', async () => {
    const { value, mock, stopUpdates } = await deps(false);
    await handleLocationUpdate({ data: { locations: [fix()] } }, value);
    expect(mock.inspect.pings()).toHaveLength(0);
    expect(stopUpdates).toHaveBeenCalled();
  });

  it('sends nothing and stops the updates without a session', async () => {
    const { value, mock, stopUpdates } = await deps(true, false);
    await handleLocationUpdate({ data: { locations: [fix()] } }, value);
    expect(mock.inspect.pings()).toHaveLength(0);
    expect(stopUpdates).toHaveBeenCalled();
  });

  it('stops collecting and forgets the session when the server rejects it', async () => {
    const { value, stopUpdates, clearSession } = await deps(true);
    const rejected: TaskDeps = {
      ...value,
      api: () => ({
        ...value.api(),
        sendPings: () => Promise.reject(new ApiError(401, 'session.invalid')),
      }),
    };
    await handleLocationUpdate({ data: { locations: [fix()] } }, rejected);
    expect(stopUpdates).toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalled();
  });

  it('ignores an error batch and a failed send', async () => {
    const { value } = await deps(true);
    await handleLocationUpdate({ error: { message: 'denied' } }, value);
    const failing: TaskDeps = {
      ...value,
      api: () => ({ ...value.api(), sendPings: () => Promise.reject(new Error('offline')) }),
    };
    await expect(
      handleLocationUpdate({ data: { locations: [fix()] } }, failing),
    ).resolves.toBeUndefined();
  });
});
