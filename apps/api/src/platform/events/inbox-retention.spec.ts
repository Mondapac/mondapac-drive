import { Temporal } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import path from 'node:path';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { JobContext } from '../scheduler/job-registry';
import {
  INBOX_PURGE_BATCH,
  INBOX_PURGE_MAX_BATCHES,
  inboxRetentionJob,
  type InboxPurger,
} from './inbox-retention';

const ROOT = path.resolve(__dirname, '../../../../..');
const NOW = Temporal.Instant.from('2026-10-27T00:00:00Z');
const markets = new MarketRegistry(
  loadMarketConfigs([path.join(ROOT, 'config/markets'), path.join(ROOT, 'test/fixtures/markets')], [
    'AU',
    'ZZ',
  ] as never),
);

class FakePurger implements InboxPurger {
  readonly calls: { market: MarketContext; before: Temporal.Instant; limit: number }[] = [];
  constructor(private readonly answers: Record<string, number>[]) {}
  purgeHandled(market: MarketContext, before: Temporal.Instant, limit: number) {
    this.calls.push({ market, before, limit });
    return Promise.resolve(this.answers[this.calls.length - 1] ?? { tracking: 0, dispatch: 0 });
  }
}

const contextOf = (code: string) =>
  testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system') as JobContext;

describe('platform.inbox-retention', () => {
  it.each([
    ['AU', 30],
    ['ZZ', 14],
  ])("purges %s's rows older than its inboxRetentionDays (%i)", async (code, days) => {
    const purger = new FakePurger([{ tracking: 4, dispatch: 0 }]);
    const job = inboxRetentionJob(purger, markets, new FixedClock(NOW));
    expect(job.name).toBe('platform.inbox-retention');
    await job.run(contextOf(code));
    expect(purger.calls).toHaveLength(1);
    expect(purger.calls[0]!.market.marketId).toBe(code);
    expect(purger.calls[0]!.limit).toBe(INBOX_PURGE_BATCH);
    expect(purger.calls[0]!.before.toString()).toBe(NOW.subtract({ hours: days * 24 }).toString());
  });

  it('continues while any inbox filled a batch, up to the batch cap', async () => {
    const full = { tracking: INBOX_PURGE_BATCH, dispatch: 1 };
    const backlog = new FakePurger([full, full, { tracking: 3, dispatch: 0 }]);
    await inboxRetentionJob(backlog, markets, new FixedClock(NOW)).run(contextOf('AU'));
    expect(backlog.calls).toHaveLength(3);

    const endless = new FakePurger(Array.from({ length: 200 }, () => full));
    await inboxRetentionJob(endless, markets, new FixedClock(NOW)).run(contextOf('ZZ'));
    expect(endless.calls).toHaveLength(INBOX_PURGE_MAX_BATCHES);
  });
});
