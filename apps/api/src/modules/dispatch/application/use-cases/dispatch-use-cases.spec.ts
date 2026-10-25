import {
  geoPoint,
  money,
  parseId,
  Temporal,
  type Id,
  type MarketId,
} from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { InMemoryCouriers } from '../../../../../test/support/dispatch-couriers';
import {
  FakeCourierAccounts,
  FakeDeliveryFacts,
  FakeOfferEarnings,
  FakeUnitOfWork,
  InMemoryDispatchJobs,
  RecordingAudit,
  RecordingOutbox,
} from '../../../../../test/support/dispatch-fakes';
import {
  AU,
  courier,
  courierId,
  dispatchSettings,
  ZZ,
} from '../../../../../test/support/dispatch-markets';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { pendingOffers } from '../../domain/dispatch-job';
import { JobAdvancer } from '../job-advancer';
import { AdvanceDispatchJobs } from './advance-dispatch-jobs.use-case';
import { AnswerOffer } from './answer-offer.use-case';
import { AssignCourier } from './assign-courier.use-case';
import { CancelDispatchJob } from './cancel-dispatch-job.use-case';
import { FollowDeliveryStatus } from './follow-delivery-status.use-case';
import { OpenDispatchJob } from './open-dispatch-job.use-case';
import { RestartOffering } from './restart-offering.use-case';
import { ViewCurrentOffer } from './view-current-offer.use-case';
import { ViewDispatchJob } from './view-dispatch-job.use-case';

const start = Temporal.Instant.from('2026-11-02T08:00:00Z');
const deliveryId = '0190a000-0000-7000-8000-0000000000d1' as Id<'Delivery'>;

let eventCounter = 0;
/** A fresh event delivery to a subscriber, as the dispatcher hands it out. */
function delivered(subscriber = 'dispatch.test'): EventDelivery {
  eventCounter += 1;
  const id = parseId<'event'>(
    `0190b000-0000-7000-8000-${eventCounter.toString(16).padStart(12, '0')}`,
  );
  if (!id.ok) throw new Error('bad id');
  return { eventId: id.value, subscriber, attempt: 1 };
}

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('dispatch use cases in %s, timed by a fake clock', (code, marketId: MarketId) => {
  const settings = dispatchSettings.get(marketId);
  const timeout = { seconds: settings.offerTimeoutSeconds };
  const market = testMarketContext(marketId, 'mondapac');
  const system = testCallContext(market, 'system');
  const signedIn = (population: 'courier' | 'admin', accountId: string) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: accountId as never,
        sessionId: '0190c000-0000-7000-8000-000000000001' as never,
        merchantId: null,
      }),
      `dispatch-${population}-0001`,
    );
  const courierCall = (n: number) => signedIn('courier', courierId(n));
  const dispatcher = signedIn('admin', '0190c000-0000-7000-8000-0000000000ad');

  function setUp() {
    const gate = openGate();
    const clock = new FixedClock(start);
    const jobs = new InMemoryDispatchJobs();
    const outbox = new RecordingOutbox();
    const audit = new RecordingAudit();
    const unitOfWork = new FakeUnitOfWork(outbox, audit);
    const couriers = new InMemoryCouriers();
    const facts = new FakeDeliveryFacts();
    const accounts = new FakeCourierAccounts();
    const earnings = new FakeOfferEarnings();
    const ids = new SequenceIdGenerator(clock);
    const advancer = new JobAdvancer(
      jobs,
      dispatchSettings,
      couriers,
      couriers,
      facts,
      outbox,
      unitOfWork,
      ids,
      clock,
    );
    facts.book(deliveryId);
    return {
      clock,
      jobs,
      outbox,
      audit,
      couriers,
      facts,
      accounts,
      earnings,
      open: new OpenDispatchJob(gate, {
        jobs,
        facts,
        settings: dispatchSettings,
        unitOfWork,
        ids,
        clock,
        advancer,
      }),
      sweep: new AdvanceDispatchJobs(gate, { jobs, unitOfWork, clock, advancer }),
      follow: new FollowDeliveryStatus(gate, {
        jobs,
        facts,
        settings: dispatchSettings,
        outbox,
        unitOfWork,
        clock,
        advancer,
      }),
      cancel: new CancelDispatchJob(gate, { jobs, outbox, unitOfWork, clock }),
      offer: new ViewCurrentOffer(gate, { jobs, earnings, unitOfWork, clock }),
      answer: new AnswerOffer(gate, { jobs, outbox, unitOfWork, clock }),
      view: new ViewDispatchJob(gate, { jobs, unitOfWork }),
      assign: new AssignCourier(gate, {
        jobs,
        couriers: accounts,
        outbox,
        audit,
        unitOfWork,
        clock,
      }),
      restart: new RestartOffering(gate, { jobs, audit, unitOfWork, clock }),
    };
  }
  type Setup = ReturnType<typeof setUp>;

  /** Couriers 1 to n, n * 500 m from the pickup. */
  function onShift(couriers: InMemoryCouriers, n: number): void {
    for (let i = 1; i <= n; i += 1) couriers.put(market, courier(i), i * 500);
  }

  const book = (t: Setup, version = 1) =>
    t.open.execute(system, { delivery: delivered(), deliveryId, deliveryVersion: version });
  const sweep = async (t: Setup) => {
    const swept = await t.sweep.execute(system, {});
    if (!swept.ok) throw new Error(swept.error.code);
    return swept.value;
  };
  const jobOf = async (t: Setup) => (await t.jobs.findByDelivery(market, deliveryId))!;
  const offeredTo = async (t: Setup) => pendingOffers(await jobOf(t)).map((o) => o.courierId);
  const offerIdOf = async (t: Setup, n: number) =>
    (await jobOf(t)).offers.find((o) => o.courierId === courierId(n) && o.status === 'PENDING')!.id;
  const status = (
    t: Setup,
    version: number,
    previousStatus: string,
    next: string,
    extra: { courierId?: Id<'Courier'>; reason?: string } = {},
  ) =>
    t.follow.execute(system, {
      delivery: delivered(),
      deliveryId,
      deliveryVersion: version,
      status: next,
      previousStatus,
      courierId: extra.courierId ?? null,
      reason: extra.reason ?? null,
    });

  describe('opening and offering', () => {
    it('opens a job from the booking with the delivery read, and sends the first wave', async () => {
      const t = setUp();
      onShift(t.couriers, 4);

      const opened = await book(t);

      expect(opened.ok && opened.value?.requirements).toMatchObject({
        serviceAreaCode: 'area-1',
        minimumVehicle: 'motorbike',
        temperature: 'chilled',
      });
      expect(await offeredTo(t)).toEqual([1, 2, 3, 4].slice(0, settings.waveSize).map(courierId));
      expect(t.outbox.take()).toEqual(
        Array.from({ length: settings.waveSize }, () => 'dispatch.offer-sent.v1'),
      );

      const again = await book(t);
      expect(again.ok && again.value?.id).toBe(opened.ok && opened.value?.id);
      expect(t.outbox.events).toEqual([]);
    });

    it('opens nothing for a delivery cancelled before its booking event arrived', async () => {
      const t = setUp();
      t.facts.book(deliveryId, { status: 'CANCELLED' });

      expect(await book(t)).toEqual({ ok: true, value: null });
      expect(await t.jobs.findByDelivery(market, deliveryId)).toBeUndefined();
    });

    it('retries a booking whose delivery cannot be read yet', async () => {
      const t = setUp();
      t.facts.deliveries.clear();

      const opened = await book(t);
      expect(opened.ok || opened.error.code).toBe('dispatch.delivery-not-found');
    });

    it("lets an offer lapse after the Market's accept timeout and moves to the next couriers", async () => {
      const t = setUp();
      onShift(t.couriers, 4);
      await book(t);
      t.outbox.take();

      t.clock.advance(Temporal.Duration.from(timeout).subtract({ milliseconds: 1 }));
      expect(await sweep(t)).toEqual({ advanced: 0 });

      t.clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
      expect(await sweep(t)).toEqual({ advanced: 1 });
      expect(t.outbox.take()).toEqual([
        ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-expired.v1'),
        ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-sent.v1'),
      ]);
      expect(await offeredTo(t)).toEqual(
        [1, 2, 3, 4].slice(settings.waveSize, settings.waveSize * 2).map(courierId),
      );
    });

    it('opens a scheduled delivery at its lead time', async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      const windowStart = start.add({ hours: 2 });
      t.facts.book(deliveryId, {
        status: 'SCHEDULED',
        window: { start: windowStart, end: windowStart.add({ hours: 1 }) },
      });
      await book(t);
      expect(await offeredTo(t)).toEqual([]);
      expect((await jobOf(t)).stops).toBeUndefined();

      t.facts.book(deliveryId, {
        status: 'SCHEDULED',
        dropoff: {
          suburb: 'New Town',
          postcode: '4102',
          point: geoPoint(-27.6, 153.1),
        },
      });
      t.clock.set(windowStart.subtract({ minutes: settings.scheduledLeadMinutes }));
      await sweep(t);

      expect(await offeredTo(t)).toEqual([courierId(1)]);
      expect((await jobOf(t)).stops?.dropoffArea).toEqual({ suburb: 'New Town', postcode: '4102' });
    });

    it('is exhausted after the last round', async () => {
      const t = setUp();
      await book(t);
      for (let round = 1; round <= settings.maxRounds; round += 1) {
        t.clock.advance(Temporal.Duration.from(timeout));
        await sweep(t);
      }

      const job = await jobOf(t);
      expect(job.status).toBe('EXHAUSTED');
      expect(job.stops).toBeUndefined();
      expect(t.outbox.take()).toEqual(['dispatch.job-exhausted.v1']);
      expect(await sweep(t)).toEqual({ advanced: 0 });
    });
  });

  describe('the courier and their offer', () => {
    it('shows a courier their own open offer, with both stops, and nothing to anyone else', async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      await book(t);

      const mine = await t.offer.execute(courierCall(1), {});
      expect(mine.ok && mine.value).toMatchObject({
        offerId: await offerIdOf(t, 1),
        deliveryId,
        expiresAt: start.add(timeout),
        pickup: { suburb: 'Pickup Vale', postcode: '4000', point: geoPoint(-27.47, 153.02) },
        dropoff: { suburb: null, postcode: '4101', point: geoPoint(-27.5, 153.05) },
        tripDistanceMetres: 4200,
        temperature: 'chilled',
      });
      expect(await t.offer.execute(courierCall(2), {})).toEqual({ ok: true, value: null });

      t.clock.advance(Temporal.Duration.from(timeout));
      expect(await t.offer.execute(courierCall(1), {})).toEqual({ ok: true, value: null });
    });

    it("prices the offer with payouts' quote, asked as the courier with the delivery's facts", async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      await book(t);
      const pay = money(1234n, code === 'AU' ? 'AUD' : 'JPY');
      t.earnings.amount = pay;

      const mine = await t.offer.execute(courierCall(1), {});
      expect(mine.ok && mine.value).toMatchObject({ earnings: pay });
      expect(t.earnings.asked).toEqual([
        {
          courier: courierId(1),
          offer: { deliveryId, vehicle: 'motorbike', distanceMetres: 4200, temperature: 'chilled' },
        },
      ]);

      t.earnings.amount = null;
      const unpriced = await t.offer.execute(courierCall(1), {});
      expect(unpriced.ok && unpriced.value).toMatchObject({ earnings: null });
    });

    it('assigns the delivery to the courier who accepts, taking the courier from the session', async () => {
      const t = setUp();
      onShift(t.couriers, 2);
      await book(t);
      const offerId = await offerIdOf(t, 1);

      const accepted = await t.answer.execute(courierCall(1), { offerId, answer: 'accept' });

      expect(accepted).toEqual({ ok: true, value: { deliveryId, assigned: true } });
      const job = await jobOf(t);
      expect(job.assignment).toMatchObject({ courierId: courierId(1), method: 'offer' });
      expect(job.stops).toBeUndefined();
      expect(t.outbox.types()).toContain('dispatch.courier-assigned.v1');
    });

    it("refuses another courier's offer as if it did not exist, and changes nothing", async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      await book(t);
      const offerId = await offerIdOf(t, 1);
      t.outbox.take();

      for (const id of [offerId, 'not-an-id', '0190a000-0000-7000-8000-0000000000ff']) {
        const stolen = await t.answer.execute(courierCall(2), { offerId: id, answer: 'accept' });
        expect(stolen.ok || stolen.error.code).toBe('offer.not-found');
      }
      expect(await offeredTo(t)).toEqual([courierId(1)]);
      expect(t.outbox.events).toEqual([]);
    });

    it('refuses an accept after the timeout, even before the sweep ran', async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      await book(t);
      const offerId = await offerIdOf(t, 1);

      t.clock.advance(Temporal.Duration.from(timeout));
      const late = await t.answer.execute(courierCall(1), { offerId, answer: 'accept' });

      expect(late.ok || late.error.code).toBe('offer.expired');
    });

    it('sends the next wave on the sweep after the last courier of a wave declines', async () => {
      const t = setUp();
      onShift(t.couriers, settings.waveSize + 1);
      await book(t);

      for (let n = 1; n <= settings.waveSize; n += 1) {
        const offerId = await offerIdOf(t, n);
        const declined = await t.answer.execute(courierCall(n), { offerId, answer: 'decline' });
        expect(declined).toEqual({ ok: true, value: { deliveryId, assigned: false } });
      }
      expect(await offeredTo(t)).toEqual([]);

      await sweep(t);
      expect(await offeredTo(t)).toEqual([courierId(settings.waveSize + 1)]);
    });

    it('refuses an admin or the system on the courier use cases', async () => {
      const t = setUp();
      for (const context of [dispatcher, system]) {
        expect(await t.offer.execute(context, {})).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
        const offerId = '0190a000-0000-7000-8000-0000000000ff';
        expect(await t.answer.execute(context, { offerId, answer: 'accept' })).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });
  });

  describe('dispatchers', () => {
    it('assigns an active courier by hand, withdrawing the offers out, with an audit row', async () => {
      const t = setUp();
      onShift(t.couriers, 2);
      await book(t);
      t.outbox.take();
      t.accounts.active.add(courierId(9));

      const assigned = await t.assign.execute(dispatcher, {
        deliveryId,
        courierId: courierId(9),
        vehicle: 'van',
      });

      expect(assigned.ok && assigned.value.assignment).toMatchObject({
        courierId: courierId(9),
        vehicle: 'van',
        method: 'manual',
      });
      expect(t.outbox.take()).toEqual([
        ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-withdrawn.v1'),
        'dispatch.courier-assigned.v1',
      ]);
      expect(t.audit.entries).toMatchObject([
        {
          action: 'dispatch.job.courier-assigned',
          before: { status: 'offering', courierId: null },
          after: { status: 'assigned', courierId: courierId(9), vehicle: 'van' },
        },
      ]);
    });

    it('refuses a courier who is not active, an unknown delivery, and a denied courier check', async () => {
      const t = setUp();
      await book(t);
      const input = { deliveryId, courierId: courierId(9), vehicle: 'car' as const };

      const inactive = await t.assign.execute(dispatcher, input);
      expect(inactive.ok || inactive.error.code).toBe('dispatch.courier-not-active');

      t.accounts.active.add(courierId(9));
      const unknown = await t.assign.execute(dispatcher, {
        ...input,
        deliveryId: '0190a000-0000-7000-8000-0000000000ee',
      });
      expect(unknown.ok || unknown.error.code).toBe('dispatch.not-found');

      t.accounts.denied = true;
      const denied = await t.assign.execute(dispatcher, input);
      expect(denied.ok || denied.error.code).toBe('access.denied');
      expect(t.audit.entries).toEqual([]);
    });

    it('restarts offering after every round lapsed, audited, and the sweep sends the wave', async () => {
      const t = setUp();
      await book(t);
      for (let round = 1; round <= settings.maxRounds; round += 1) {
        t.clock.advance(Temporal.Duration.from(timeout));
        await sweep(t);
      }
      onShift(t.couriers, 1);

      const restarted = await t.restart.execute(dispatcher, { deliveryId });
      expect(restarted.ok && restarted.value.status).toBe('OFFERING');
      expect(t.audit.actions()).toEqual(['dispatch.job.offering-restarted']);

      await sweep(t);
      expect(await offeredTo(t)).toEqual([courierId(1)]);
      expect((await jobOf(t)).stops?.pickupArea).toEqual({
        suburb: 'Pickup Vale',
        postcode: '4000',
      });

      const again = await t.restart.execute(dispatcher, { deliveryId });
      expect(again.ok || again.error.code).toBe('dispatch.not-exhausted');
    });

    it("shows a delivery's job to an admin and refuses a courier", async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      await book(t);

      const job = await t.view.execute(dispatcher, { deliveryId });
      expect(job.ok && job.value.offers.map((o) => o.courierId)).toEqual([courierId(1)]);
      for (const useCase of [
        () => t.view.execute(courierCall(1), { deliveryId }),
        () => t.restart.execute(courierCall(1), { deliveryId }),
        () =>
          t.assign.execute(courierCall(1), { deliveryId, courierId: courierId(1), vehicle: 'car' }),
      ]) {
        expect(await useCase()).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
    });
  });

  describe('following the delivery', () => {
    async function assignedByOffer(t: Setup) {
      onShift(t.couriers, 3);
      await book(t);
      const offerId = await offerIdOf(t, 1);
      await t.answer.execute(courierCall(1), { offerId, answer: 'accept' });
      t.outbox.take();
    }

    it('offers the delivery again, without its courier, when a dispatcher unassigns it', async () => {
      const t = setUp();
      await assignedByOffer(t);
      t.facts.book(deliveryId, {
        dropoff: {
          suburb: 'New Town',
          postcode: '4102',
          point: geoPoint(-27.6, 153.1),
        },
      });

      const followed = await status(t, 3, 'assigned', 'dispatching', {
        reason: 'dispatcher-unassigned',
      });

      expect(followed.ok && followed.value?.status).toBe('OFFERING');
      const job = await jobOf(t);
      expect(job.excludedCourierIds).toEqual([courierId(1)]);
      expect(job.stops?.dropoffArea).toEqual({ suburb: 'New Town', postcode: '4102' });
      expect(await offeredTo(t)).not.toContain(courierId(1));
      expect(await offeredTo(t)).toHaveLength(settings.waveSize);
    });

    it('ignores the step back that is half of a reassignment', async () => {
      const t = setUp();
      await assignedByOffer(t);

      await status(t, 3, 'assigned', 'dispatching', { reason: 'courier-reassigned' });

      expect((await jobOf(t)).status).toBe('ASSIGNED');
    });

    it('records a courier the delivery assigned, withdrawing offers without republishing', async () => {
      const t = setUp();
      onShift(t.couriers, 2);
      await book(t);
      t.outbox.take();

      await status(t, 2, 'dispatching', 'assigned', { courierId: courierId(8) });

      const job = await jobOf(t);
      expect(job.assignment?.courierId).toBe(courierId(8));
      expect(t.outbox.take()).toEqual(
        Array.from({ length: settings.waveSize }, () => 'dispatch.offer-withdrawn.v1'),
      );
    });

    it('closes the job once the courier collected the parcel, and refuses a reassignment', async () => {
      const t = setUp();
      await assignedByOffer(t);
      t.accounts.active.add(courierId(2));

      await status(t, 4, 'at-pickup', 'picked-up', { courierId: courierId(1) });

      const job = await jobOf(t);
      expect(job.status).toBe('COLLECTED');
      expect(job.assignment?.courierId).toBe(courierId(1));
      const refused = await t.assign.execute(dispatcher, {
        deliveryId,
        courierId: courierId(2),
        vehicle: 'car',
      });
      expect(refused.ok || refused.error.code).toBe('dispatch.collected');
      expect(t.audit.entries).toEqual([]);
      expect(t.outbox.take()).toEqual([]);
    });

    it('records the courier the delivery names at pickup over a reassignment that raced it', async () => {
      const t = setUp();
      await assignedByOffer(t);
      t.accounts.active.add(courierId(2));
      await t.assign.execute(dispatcher, { deliveryId, courierId: courierId(2), vehicle: 'car' });

      await status(t, 4, 'at-pickup', 'picked-up', { courierId: courierId(1) });

      expect((await jobOf(t)).assignment?.courierId).toBe(courierId(1));
    });

    it('changes nothing for a late or repeated event', async () => {
      const t = setUp();
      await assignedByOffer(t);
      await status(t, 5, 'dispatching', 'assigned', { courierId: courierId(1) });
      const before = await jobOf(t);

      await status(t, 4, 'assigned', 'dispatching', { reason: 'dispatcher-unassigned' });

      expect(await jobOf(t)).toEqual(before);
    });

    it('opens a scheduled job when a dispatcher opens its delivery early', async () => {
      const t = setUp();
      onShift(t.couriers, 1);
      const windowStart = start.add({ hours: 5 });
      t.facts.book(deliveryId, {
        status: 'SCHEDULED',
        window: { start: windowStart, end: windowStart.add({ hours: 1 }) },
      });
      await book(t);

      await status(t, 2, 'scheduled', 'dispatching');

      expect(await offeredTo(t)).toEqual([courierId(1)]);
    });

    it('withdraws the offers out when the delivery is cancelled, once per event', async () => {
      const t = setUp();
      onShift(t.couriers, 2);
      await book(t);
      t.outbox.take();
      const event = delivered();

      expect(await t.cancel.execute(system, { delivery: event, deliveryId })).toEqual({
        ok: true,
        value: { cancelled: true },
      });
      expect(t.outbox.take()).toEqual(
        Array.from({ length: settings.waveSize }, () => 'dispatch.offer-withdrawn.v1'),
      );
      expect((await jobOf(t)).stops).toBeUndefined();
      expect(await t.cancel.execute(system, { delivery: event, deliveryId })).toEqual({
        ok: true,
        value: { cancelled: false },
      });
      t.clock.advance(Temporal.Duration.from({ hours: 1 }));
      expect(await sweep(t)).toEqual({ advanced: 0 });
    });

    it('runs the event and sweep use cases for the system only', async () => {
      const t = setUp();
      const zz = code as 'AU' | 'ZZ';
      await expectSystemOnly(zz, (context) =>
        t.open.execute(context, { delivery: delivered(), deliveryId, deliveryVersion: 1 }),
      );
      await expectSystemOnly(zz, (context) => t.sweep.execute(context, {}));
      await expectSystemOnly(zz, (context) =>
        t.cancel.execute(context, { delivery: delivered(), deliveryId }),
      );
      await expectSystemOnly(zz, (context) =>
        t.follow.execute(context, {
          delivery: delivered(),
          deliveryId,
          deliveryVersion: 9,
          status: 'dispatching',
          previousStatus: 'assigned',
          courierId: null,
          reason: null,
        }),
      );
    });
  });
});
