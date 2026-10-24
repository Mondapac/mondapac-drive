import { newClock } from '../../../../test/support/tracking-markets';
import { testAppConfig } from '../../../../test/support/test-config';
import { InMemoryLivePositionStore } from './in-memory-live-position-store';
import { RedisLivePositionStore } from './redis-live-position-store';
import { livePositionStoreFor, TrackingStoreConfigError } from './tracking-providers';

describe('the live position store binding', () => {
  it('keeps positions in this process without REDIS_URL, outside production', () => {
    expect(livePositionStoreFor(testAppConfig(), newClock())).toBeInstanceOf(
      InMemoryLivePositionStore,
    );
  });

  it('refuses to start in production without REDIS_URL', () => {
    const config = { ...testAppConfig(), nodeEnv: 'production' as const };
    expect(() => livePositionStoreFor(config, newClock())).toThrow(TrackingStoreConfigError);
  });

  it('uses Redis when REDIS_URL is set, without connecting until a command is sent', async () => {
    const store = livePositionStoreFor(
      testAppConfig({ REDIS_URL: 'redis://127.0.0.1:1' }),
      newClock(),
    );
    expect(store).toBeInstanceOf(RedisLivePositionStore);
    await (store as RedisLivePositionStore).onApplicationShutdown();
  });
});
