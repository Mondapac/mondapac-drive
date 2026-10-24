import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac-drive/shared-kernel/testing';
import { JobAdvancer } from '../../src/modules/dispatch/application/job-advancer';
import { AdvanceDispatchJobs } from '../../src/modules/dispatch/application/use-cases/advance-dispatch-jobs.use-case';
import { AnswerOffer } from '../../src/modules/dispatch/application/use-cases/answer-offer.use-case';
import {
  answerOffer,
  followedDeliveryVersion,
  openEarly,
  openDispatchJob,
  pendingOffers,
  sendWave,
  sweep,
  type DispatchJob,
} from '../../src/modules/dispatch/domain/dispatch-job';
import { DISPATCH_EVENTS } from '../../src/modules/dispatch/domain/events/dispatch-events';
import { InMemoryCouriers } from '../support/dispatch-couriers';
import { PrismaDispatchJobRepository } from '../../src/modules/dispatch/infrastructure/prisma-dispatch-job.repository';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import {
  courier,
  courierId,
  dispatchSettings,
  requirements,
  stops,
} from '../support/dispatch-markets';
import { openGate } from '../support/system-only-denial';
import { TEST_MARKETS } from '../support/test-config';
import { eventContext, ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The dispatch repository on PostgreSQL, through the platform's unit of work and market guard,
// for both Market fixtures as the application role: a job round-trips with its offers, an
// update writes new offers and answers under the version check, the sweep finds only due open
// jobs, no Market sees another's job, and a whole offer round writes its events to the
// dispatch outbox.

const at = Temporal.Instant.from('2026-11-02T08:00:00Z');
const newId = <K extends string>() => ids.next<K>();

describe('dispatch repository (database integration)', () => {
  let db: Persistence;
  let repository: PrismaDispatchJobRepository;

  beforeAll(() => {
    db = createPersistence();
    repository = new PrismaDispatchJobRepository(db.service);
  });

  afterAll(async () => {
    await db.close();
  });

  const inUnit = <T>(code: string, work: () => Promise<T>, readOnly = false) =>
    db.unitOfWork.run(
      marketOf(code),
      async () => ({ ok: true as const, value: await work() }),
      readOnly ? { readOnly: true } : {},
    );

  function newJob(code: string, windowStart?: Temporal.Instant): DispatchJob {
    return openDispatchJob(
      {
        id: newId<'DispatchJob'>(),
        marketId: marketOf(code).marketId,
        deliveryId: newId<'Delivery'>(),
        requirements: requirements(),
        stops: stops(),
        deliveryVersion: 1,
        ...(windowStart === undefined ? {} : { windowStart }),
      },
      at,
      dispatchSettings.get(marketOf(code).marketId),
    );
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const settings = dispatchSettings.get(market.marketId);

    it('stores a job with its offers and answers, and reads it back unchanged', async () => {
      const opened = newJob(code);
      await inUnit(code, () => repository.insert(market, opened));

      const swept = sweep(opened, at, settings);
      const wave = sendWave(
        swept.job,
        [1, 2].map((n) => ({
          courierId: courierId(n),
          vehicle: 'car' as const,
          distanceMetres: n,
        })),
        at,
        settings,
        () => newId<'DispatchOffer'>(),
      ).job;
      await inUnit(code, () => repository.update(market, wave));
      const offer = wave.offers.find((o) => o.courierId === courierId(1))!;
      const accepted = answerOffer(
        wave,
        offer.id,
        courierId(1),
        'accept',
        at.add({ seconds: 3 }),
      ).job;
      await inUnit(code, () => repository.update(market, accepted));

      const read = await inUnit(code, () => repository.findById(market, opened.id), true);
      expect(read.ok && read.value).toEqual(accepted);
      const byDelivery = await inUnit(
        code,
        () => repository.findByDelivery(market, opened.deliveryId),
        true,
      );
      expect(byDelivery.ok && byDelivery.value?.id).toBe(opened.id);
      const byOffer = await inUnit(code, () => repository.findByOffer(market, offer.id), true);
      expect(byOffer.ok && byOffer.value?.id).toBe(opened.id);
    });

    it("keeps the offer's stops while offering, drops them once assigned, and finds a courier's pending offers", async () => {
      const opened = newJob(code);
      await inUnit(code, () => repository.insert(market, opened));
      const wave = sendWave(
        sweep(opened, at, settings).job,
        [{ courierId: courierId(3), vehicle: 'car' as const, distanceMetres: 1 }],
        at,
        settings,
        () => newId<'DispatchOffer'>(),
      ).job;
      await inUnit(code, () => repository.update(market, wave));

      const pending = await inUnit(
        code,
        () => repository.findWithPendingOfferFor(market, courierId(3)),
        true,
      );
      expect(pending.ok && pending.value.map((job) => job.id)).toContain(opened.id);
      const found = pending.ok ? pending.value.find((job) => job.id === opened.id) : undefined;
      expect(found?.stops).toEqual(stops());

      const offer = wave.offers[0]!;
      const accepted = answerOffer(wave, offer.id, courierId(3), 'accept', at).job;
      const followed = followedDeliveryVersion(accepted, accepted, 3);
      await inUnit(code, () =>
        repository.update(market, { ...followed, version: wave.version + 1 }),
      );
      const read = await inUnit(code, () => repository.findById(market, opened.id), true);
      expect(read.ok && read.value?.stops).toBeUndefined();
      expect(read.ok && read.value?.deliveryVersion).toBe(3);
      const none = await inUnit(
        code,
        () => repository.findWithPendingOfferFor(market, courierId(3)),
        true,
      );
      expect(none.ok && none.value.map((job) => job.id)).not.toContain(opened.id);
    });

    it('moves the opening time of a scheduled job forward', async () => {
      const later = newJob(code, at.add({ hours: 24 }));
      await inUnit(code, () => repository.insert(market, later));
      const early = openEarly(later, at).job;
      await inUnit(code, () => repository.update(market, early));

      const due = await inUnit(code, () => repository.findDue(market, at, 1000), true);
      expect(due.ok && due.value).toContain(later.id);
    });

    it('refuses a second job for the same delivery', async () => {
      const first = newJob(code);
      const second = { ...newJob(code), deliveryId: first.deliveryId };

      expect(await inUnit(code, () => repository.insert(market, first))).toEqual({
        ok: true,
        value: true,
      });
      expect(await inUnit(code, () => repository.insert(market, second))).toEqual({
        ok: true,
        value: false,
      });
    });

    it('refuses an update over a version that changed meanwhile', async () => {
      const job = newJob(code);
      await inUnit(code, () => repository.insert(market, job));
      const next = { ...sweep(job, at, settings).job, version: 2 };
      await inUnit(code, () => repository.update(market, next));

      await expect(inUnit(code, () => repository.update(market, next))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
    });

    it("finds only the open jobs that are due, and none of another Market's", async () => {
      const due = newJob(code);
      const later = newJob(code, at.add({ hours: 24 }));
      await inUnit(code, () => repository.insert(market, due));
      await inUnit(code, () => repository.insert(market, later));

      const found = await inUnit(code, () => repository.findDue(market, at, 1000), true);
      expect(found.ok && found.value).toContain(due.id);
      expect(found.ok && found.value).not.toContain(later.id);

      const other = marketOf(otherMarketOf(code));
      const elsewhere = await inUnit(
        otherMarketOf(code),
        () => repository.findById(other, due.id),
        true,
      );
      expect(elsewhere.ok && elsewhere.value).toBeUndefined();
    });

    it('writes an offer round to the dispatch outbox: sent, then accepted and assigned', async () => {
      const clock = new FixedClock(at);
      const catalogue = new EventCatalogue();
      catalogue.register('dispatch', DISPATCH_EVENTS);
      catalogue.seal();
      const outbox = new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('dispatch');
      const couriers = new InMemoryCouriers();
      couriers.put(market, courier(1), 400);
      couriers.put(market, courier(2), 800);
      const advancer = new JobAdvancer(
        repository,
        dispatchSettings,
        couriers,
        couriers,
        outbox,
        db.unitOfWork,
        ids,
        clock,
      );
      const gate = openGate();
      const sweepJobs = new AdvanceDispatchJobs(gate, {
        jobs: repository,
        unitOfWork: db.unitOfWork,
        clock,
        advancer,
      });
      const answer = new AnswerOffer(gate, {
        jobs: repository,
        outbox,
        unitOfWork: db.unitOfWork,
        clock,
      });
      const context = eventContext(market);
      const opened = newJob(code);
      const deliveryId = opened.deliveryId;
      await inUnit(code, () => repository.insert(market, opened));

      await sweepJobs.execute(context, {});
      clock.advance(Temporal.Duration.from({ seconds: settings.offerTimeoutSeconds }));
      await sweepJobs.execute(context, {});
      const job = await inUnit(code, () => repository.findByDelivery(market, deliveryId), true);
      const offer = job.ok ? pendingOffers(job.value!)[0] : undefined;
      expect(offer).toBeDefined();
      const courierContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'courier',
          accountId: offer!.courierId as never,
          sessionId: newId() as never,
          merchantId: null,
        }),
        `db-test-${ids.next()}`,
      );
      const accepted = await answer.execute(courierContext, {
        offerId: offer!.id,
        answer: 'accept',
      });
      expect(accepted).toEqual({ ok: true, value: { deliveryId, assigned: true } });

      const rows = await db.root.dispatchOutbox.findMany({
        where: { marketId: market.marketId, payload: { path: ['deliveryId'], equals: deliveryId } },
        orderBy: { eventId: 'asc' },
        select: { type: true },
      });
      const types = rows.map((row) => row.type);
      expect(types[0]).toBe('dispatch.offer-sent.v1');
      expect(types).toContain('dispatch.offer-expired.v1');
      expect(types).toContain('dispatch.offer-accepted.v1');
      expect(types).toContain('dispatch.courier-assigned.v1');
    });
  });
});
