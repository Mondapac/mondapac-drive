import {
  geoPoint,
  type AuditEntry,
  type CallContext,
  type Id,
  type MarketContext,
  type Money,
  type PendingEvent,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import type {
  CourierAccounts,
  DeliveryFacts,
  DeliveryForDispatch,
  DispatchJobRepository,
  OfferEarnings,
  OfferToPrice,
} from '../../src/modules/dispatch/application/ports';
import type { DispatchJob } from '../../src/modules/dispatch/domain/dispatch-job';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { fakeRunOnce } from './fake-run-once';

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

  findByOffer(market: MarketContext, offerId: Id<'DispatchOffer'>) {
    return Promise.resolve(
      [...this.jobs.values()].find(
        (job) => job.marketId === market.marketId && job.offers.some((o) => o.id === offerId),
      ),
    );
  }

  findWithPendingOfferFor(market: MarketContext, courierId: Id<'Courier'>) {
    return Promise.resolve(
      [...this.jobs.values()].filter(
        (job) =>
          job.marketId === market.marketId &&
          job.offers.some((o) => o.courierId === courierId && o.status === 'PENDING'),
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

/**
 * A unit of work that runs the work once; events and audit rows appended in a refused unit are
 * dropped. `runOnce` keeps an in-memory inbox of the events handled.
 */
export class FakeUnitOfWork implements UnitOfWork {
  readonly #once = fakeRunOnce();

  constructor(
    private readonly outbox: RecordingOutbox,
    private readonly audit?: RecordingAudit,
  ) {}

  async run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    const audited = this.audit?.entries.length ?? 0;
    const result = await this.runOutbox(work);
    if (!result.ok && this.audit) this.audit.entries.length = audited;
    return result;
  }

  runOnce<T, E>(market: MarketContext, delivery: EventDelivery, work: () => Promise<Result<T, E>>) {
    return this.#once(market, delivery, () => this.run(market, work));
  }

  private async runOutbox<T, E>(work: () => Promise<Result<T, E>>) {
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

export class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];

  record(_context: CallContext, entry: AuditEntry) {
    this.entries.push(entry);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

/** Delivery's read for dispatch over a map of deliveries the test books. */
export class FakeDeliveryFacts implements DeliveryFacts {
  readonly deliveries = new Map<string, DeliveryForDispatch>();

  book(deliveryId: Id<'Delivery'>, overrides: Partial<DeliveryForDispatch> = {}): void {
    this.deliveries.set(deliveryId, {
      status: 'DISPATCHING',
      serviceAreaCode: 'area-1',
      pickup: { address: '1 Pickup Street', postcode: '4000', point: geoPoint(-27.47, 153.02) },
      dropoff: { address: '2 Dropoff Road', postcode: '4101', point: geoPoint(-27.5, 153.05) },
      distanceMetres: 4200,
      weightGrams: 5000,
      volumeLitres: 20,
      temperature: 'chilled',
      vehicle: 'motorbike',
      ...overrides,
    });
  }

  forDispatch(_context: CallContext, deliveryId: Id<'Delivery'>) {
    return Promise.resolve(this.deliveries.get(deliveryId));
  }
}

/** Identity's answer on courier accounts: the active ones are listed; `undefined` for a denial. */
export class FakeCourierAccounts implements CourierAccounts {
  readonly active = new Set<string>();
  denied = false;

  isActive(_context: CallContext, accountId: string) {
    return Promise.resolve(this.denied ? undefined : this.active.has(accountId));
  }
}

/** Payouts' quote for an offer: a fixed amount, or null; it records what it was asked. */
export class FakeOfferEarnings implements OfferEarnings {
  readonly asked: { readonly courier: string | null; readonly offer: OfferToPrice }[] = [];
  amount: Money | null = null;

  forOffer(context: CallContext, offer: OfferToPrice) {
    const { actor } = context;
    this.asked.push({ courier: actor.kind === 'authenticated' ? actor.accountId : null, offer });
    return Promise.resolve(this.amount);
  }
}
