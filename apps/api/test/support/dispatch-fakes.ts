import {
  type CallContext,
  type Id,
  type MarketContext,
  type PendingEvent,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import type {
  DeliveryLink,
  DispatchJobRepository,
} from '../../src/modules/dispatch/application/ports';
import type { VehicleType } from '../../src/modules/dispatch/domain/courier';
import type { DispatchJob } from '../../src/modules/dispatch/domain/dispatch-job';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { noRunOnce } from './fake-run-once';

/**
 * In-memory stand-ins for the dispatch use cases' ports, for suites without a database. The
 * PostgreSQL repository is covered by test/db/dispatch-repository.db-spec.ts.
 */
export class InMemoryDispatchJobs implements DispatchJobRepository {
  readonly jobs = new Map<string, DispatchJob>();

  private key(market: MarketContext, id: string): string {
    return `${market.marketId}|${id}`;
  }

  findById(market: MarketContext, id: Id<'DispatchJob'>) {
    return Promise.resolve(this.jobs.get(this.key(market, id)));
  }

  findByDelivery(market: MarketContext, deliveryId: Id<'Delivery'>) {
    return Promise.resolve(
      [...this.jobs.values()].find(
        (job) => job.marketId === market.marketId && job.deliveryId === deliveryId,
      ),
    );
  }

  findDue(market: MarketContext, now: Temporal.Instant, limit: number) {
    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          job.marketId === market.marketId &&
          (job.status === 'WAITING' || job.status === 'OFFERING') &&
          job.nextActionAt !== undefined &&
          job.nextActionAt.epochMilliseconds <= now.epochMilliseconds,
      )
      .slice(0, limit)
      .map((job) => job.id);
    return Promise.resolve(due);
  }

  async insert(market: MarketContext, job: DispatchJob) {
    if (await this.findByDelivery(market, job.deliveryId)) return false;
    this.jobs.set(this.key(market, job.id), job);
    return true;
  }

  update(market: MarketContext, job: DispatchJob) {
    const stored = this.jobs.get(this.key(market, job.id));
    if (stored?.version !== job.version - 1) {
      return Promise.reject(new StaleAggregateError('dispatch-job', job.id));
    }
    this.jobs.set(this.key(market, job.id), job);
    return Promise.resolve();
  }
}

/** A unit of work that runs the work once; events appended in a refused unit are dropped. */
export class FakeUnitOfWork implements UnitOfWork {
  constructor(private readonly outbox: RecordingOutbox) {}

  async run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    const mark = this.outbox.events.length;
    try {
      const result = await work();
      if (!result.ok) this.outbox.events.length = mark;
      return result;
    } catch (error) {
      this.outbox.events.length = mark;
      throw error;
    }
  }

  runOnce = noRunOnce;
}

export class RecordingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];

  append(_context: CallContext, events: readonly PendingEvent[]) {
    this.events.push(...events);
    return Promise.resolve();
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  take(): string[] {
    const types = this.types();
    this.events.length = 0;
    return types;
  }
}

export class RecordingDeliveryLink implements DeliveryLink {
  readonly calls: string[] = [];

  dispatchOpened(_context: CallContext, deliveryId: Id<'Delivery'>) {
    this.calls.push(`opened ${deliveryId}`);
    return Promise.resolve();
  }

  courierAssigned(
    _context: CallContext,
    deliveryId: Id<'Delivery'>,
    courierId: Id<'Courier'>,
    vehicle: VehicleType,
  ) {
    this.calls.push(`assigned ${deliveryId} ${courierId} ${vehicle}`);
    return Promise.resolve();
  }
}
