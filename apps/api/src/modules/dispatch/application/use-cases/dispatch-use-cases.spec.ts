import { Temporal, type Id, type MarketId } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import {
  FakeUnitOfWork,
  InMemoryDispatchJobs,
  RecordingDeliveryLink,
  RecordingOutbox,
} from '../../../../../test/support/dispatch-fakes';
import {
  AU,
  courier,
  courierId,
  dispatchSettings,
  requirements,
  ZZ,
} from '../../../../../test/support/dispatch-markets';
import { pendingOffers } from '../../domain/dispatch-job';
import { InMemoryCouriers } from '../../infrastructure/in-memory-couriers';
import { JobAdvancer } from '../job-advancer';
import { AdvanceDispatchJobs } from './advance-dispatch-jobs.use-case';
import { AnswerOffer } from './answer-offer.use-case';
import { AssignCourier } from './assign-courier.use-case';
import { CancelDispatchJob } from './cancel-dispatch-job.use-case';
import { OpenDispatchJob } from './open-dispatch-job.use-case';

const start = Temporal.Instant.from('2026-11-02T08:00:00Z');
const deliveryId = '0190a000-0000-7000-8000-0000000000d1' as Id<'Delivery'>;

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('dispatch use cases in %s, timed by a fake clock', (_name, marketId: MarketId) => {
  const settings = dispatchSettings.get(marketId);
  const timeout = { seconds: settings.offerTimeoutSeconds };
  const market = testMarketContext(marketId, 'mondapac');
  const context = testCallContext(market, 'system');

  function setUp() {
    const clock = new FixedClock(start);
    const jobs = new InMemoryDispatchJobs();
    const outbox = new RecordingOutbox();
    const unitOfWork = new FakeUnitOfWork(outbox);
    const couriers = new InMemoryCouriers();
    const delivery = new RecordingDeliveryLink();
    const ids = new SequenceIdGenerator(clock);
    const advancer = new JobAdvancer(
      jobs,
      dispatchSettings,
      couriers,
      couriers,
      delivery,
      outbox,
      unitOfWork,
      ids,
      clock,
    );
    return {
      clock,
      jobs,
      outbox,
      couriers,
      delivery,
      open: new OpenDispatchJob(jobs, dispatchSettings, unitOfWork, ids, clock, advancer),
      sweep: new AdvanceDispatchJobs(jobs, unitOfWork, clock, advancer),
      answer: new AnswerOffer(jobs, delivery, outbox, unitOfWork, clock, advancer),
      assign: new AssignCourier(jobs, delivery, outbox, unitOfWork, clock),
      cancel: new CancelDispatchJob(jobs, outbox, unitOfWork, clock),
    };
  }

  /** Couriers 1 to n, n * 500 m from the pickup. */
  function onShift(couriers: InMemoryCouriers, n: number): void {
    for (let i = 1; i <= n; i += 1) couriers.put(market, courier(i), i * 500);
  }

  const offeredTo = async (t: ReturnType<typeof setUp>) =>
    pendingOffers((await t.jobs.findByDelivery(market, deliveryId))!).map((o) => o.courierId);

  it('sends the first wave to the nearest couriers as soon as the job opens', async () => {
    const t = setUp();
    onShift(t.couriers, 4);

    const opened = await t.open.run(context, { deliveryId, requirements: requirements() });

    expect(opened.ok).toBe(true);
    expect(await offeredTo(t)).toEqual([1, 2, 3, 4].slice(0, settings.waveSize).map(courierId));
    expect(t.outbox.take()).toEqual(
      Array.from({ length: settings.waveSize }, () => 'dispatch.offer-sent.v1'),
    );

    const again = await t.open.run(context, { deliveryId, requirements: requirements() });
    expect(again.ok && again.value.id).toBe(opened.ok && opened.value.id);
    expect(t.outbox.events).toEqual([]);
  });

  it("lets an offer lapse after the Market's accept timeout and moves to the next couriers", async () => {
    const t = setUp();
    onShift(t.couriers, 4);
    await t.open.run(context, { deliveryId, requirements: requirements() });
    t.outbox.take();

    t.clock.advance(Temporal.Duration.from(timeout).subtract({ milliseconds: 1 }));
    expect(await t.sweep.run(context)).toEqual({ advanced: 0 });

    t.clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    expect(await t.sweep.run(context)).toEqual({ advanced: 1 });
    expect(t.outbox.take()).toEqual([
      ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-expired.v1'),
      ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-sent.v1'),
    ]);
    const second = [1, 2, 3, 4].slice(settings.waveSize, settings.waveSize * 2).map(courierId);
    expect(await offeredTo(t)).toEqual(second);

    t.clock.advance(Temporal.Duration.from({ seconds: 1 }));
    const accepted = await t.answer.run(context, {
      deliveryId,
      courierId: second[0]!,
      answer: 'accept',
    });

    expect(accepted.ok && accepted.value.status).toBe('ASSIGNED');
    expect(t.delivery.calls).toEqual([`assigned ${deliveryId} ${second[0]} car`]);
    expect(t.outbox.types()).toContain('dispatch.courier-assigned.v1');
  });

  it('refuses an accept after the timeout, even before the sweep ran', async () => {
    const t = setUp();
    onShift(t.couriers, 1);
    await t.open.run(context, { deliveryId, requirements: requirements() });

    t.clock.advance(Temporal.Duration.from(timeout));
    const late = await t.answer.run(context, {
      deliveryId,
      courierId: courierId(1),
      answer: 'accept',
    });

    expect(late.ok || late.error.code).toBe('offer.expired');
  });

  it('sends the next wave at once when the last courier of a wave declines', async () => {
    const t = setUp();
    onShift(t.couriers, settings.waveSize + 1);
    await t.open.run(context, { deliveryId, requirements: requirements() });

    for (const id of await offeredTo(t)) {
      await t.answer.run(context, { deliveryId, courierId: id, answer: 'decline' });
    }

    expect(await offeredTo(t)).toEqual([courierId(settings.waveSize + 1)]);
  });

  it('is exhausted after the last round and then assigned by a dispatcher', async () => {
    const t = setUp();
    await t.open.run(context, { deliveryId, requirements: requirements() });
    for (let round = 1; round <= settings.maxRounds; round += 1) {
      t.clock.advance(Temporal.Duration.from(timeout));
      await t.sweep.run(context);
    }

    const job = await t.jobs.findByDelivery(market, deliveryId);
    expect(job?.status).toBe('EXHAUSTED');
    expect(t.outbox.take()).toEqual(['dispatch.job-exhausted.v1']);
    expect(await t.sweep.run(context)).toEqual({ advanced: 0 });

    const assigned = await t.assign.run(context, {
      deliveryId,
      courierId: courierId(9),
      vehicle: 'van',
    });
    expect(assigned.ok && assigned.value.assignment?.method).toBe('manual');
    expect(t.delivery.calls).toEqual([`assigned ${deliveryId} ${courierId(9)} van`]);
  });

  it('opens a scheduled delivery at its lead time and tells the delivery', async () => {
    const t = setUp();
    onShift(t.couriers, 1);
    const windowStart = start.add({ hours: 2 });
    await t.open.run(context, { deliveryId, requirements: requirements(), windowStart });
    expect(await offeredTo(t)).toEqual([]);

    t.clock.set(windowStart.subtract({ minutes: settings.scheduledLeadMinutes }));
    await t.sweep.run(context);

    expect(t.delivery.calls).toEqual([`opened ${deliveryId}`]);
    expect(await offeredTo(t)).toEqual([courierId(1)]);
  });

  it('withdraws the offers out when the delivery is cancelled', async () => {
    const t = setUp();
    onShift(t.couriers, 2);
    await t.open.run(context, { deliveryId, requirements: requirements() });
    t.outbox.take();

    expect(await t.cancel.run(context, deliveryId)).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(t.outbox.take()).toEqual(
      Array.from({ length: settings.waveSize }, () => 'dispatch.offer-withdrawn.v1'),
    );
    t.clock.advance(Temporal.Duration.from({ hours: 1 }));
    expect(await t.sweep.run(context)).toEqual({ advanced: 0 });
  });
});
