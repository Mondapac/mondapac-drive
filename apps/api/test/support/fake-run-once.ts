import { ok } from '@mondapac-drive/shared-kernel';
import type { MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

/**
 * An in-memory `UnitOfWork.runOnce` for suites without a database: a set of
 * `(Market, eventId, subscriber)` stands in for the module inbox; `work` runs only for a new
 * key, and the key is kept only when `work` answered `ok` (as a rollback would drop it). The
 * PostgreSQL behaviour is covered by test/db/event-delivery.db-spec.ts.
 */
export function fakeRunOnce(handled: Set<string> = new Set()): UnitOfWork['runOnce'] {
  return async <T, E>(
    market: MarketContext,
    delivery: EventDelivery,
    work: () => Promise<Result<T, E>>,
  ): Promise<Result<HandledOnce<T>, E>> => {
    const key = `${market.marketId}|${delivery.eventId}|${delivery.subscriber}`;
    if (handled.has(key)) return ok({ handled: false });
    const done = await work();
    if (!done.ok) return done;
    handled.add(key);
    return ok({ handled: true, value: done.value });
  };
}

/** For fakes of suites that never handle an event: a call is a test bug. */
export const noRunOnce: UnitOfWork['runOnce'] = () =>
  Promise.reject(new Error('runOnce is not expected in this suite'));
