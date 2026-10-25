import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Clock, MarketContext } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../market-config/market-registry';
import type { JobDefinition } from '../scheduler/job-registry';

/**
 * Deletes handled inbox rows (platform persistence design 6.4) of one Market and tenant, in every
 * module inbox: rows processed before `before`, at most `limit` per inbox. Answers the rows
 * deleted per module. Implemented by platform/persistence, which alone knows the tables.
 */
export interface InboxPurger {
  purgeHandled(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<Readonly<Record<string, number>>>;
}

export const INBOX_PURGER = Symbol('INBOX_PURGER');

/** Rows per inbox per statement; small enough that one DELETE never holds locks for long. */
export const INBOX_PURGE_BATCH = 1000;
/** Batches per run and inbox; the next run (6 h later) continues a backlog. */
export const INBOX_PURGE_MAX_BATCHES = 50;

const logger = new Logger('platform.inbox-retention');

/**
 * `platform.inbox-retention` (handoff 35; tracking 26b I2): every 6 hours, per Market, the inbox
 * rows of every module handled more than the Market's `events.inboxRetentionDays` ago. An inbox
 * row only guards a delivery against a second run while the dispatcher may still hand it out;
 * a delivered `platform.event_delivery` row is never claimed again and the relay never
 * re-inserts one, so a row far past the last retry is dead weight. Rows of a `dead` delivery are
 * kept, because an operator may re-drive a dead letter (the purger skips them). The Market's minimum (7 days)
 * keeps it well past every back-off. No module takes part: the inboxes come from the model map.
 * Logs counts only; safe to run twice and concurrently (each batch is one statement).
 */
export function inboxRetentionJob(
  purger: InboxPurger,
  markets: MarketRegistry,
  clock: Clock,
): JobDefinition {
  return {
    name: 'platform.inbox-retention',
    every: Temporal.Duration.from({ hours: 6 }),
    maxRunMs: 300_000,
    async run(context) {
      const { inboxRetentionDays } = markets.get(context.market.marketId).events;
      const before = clock.now().subtract({ hours: inboxRetentionDays * 24 });
      const totals: Record<string, number> = {};
      for (let batch = 0; batch < INBOX_PURGE_MAX_BATCHES; batch += 1) {
        const deleted = await purger.purgeHandled(context.market, before, INBOX_PURGE_BATCH);
        for (const [module, count] of Object.entries(deleted)) {
          totals[module] = (totals[module] ?? 0) + count;
        }
        if (Object.values(deleted).every((count) => count < INBOX_PURGE_BATCH)) break;
      }
      const purged = Object.fromEntries(Object.entries(totals).filter(([, count]) => count > 0));
      if (Object.keys(purged).length > 0) {
        logger.log({
          msg: 'platform.inbox-purged',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          purged,
        });
      }
    },
  };
}
