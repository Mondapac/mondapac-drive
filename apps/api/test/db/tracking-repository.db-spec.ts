import { randomUUID } from 'node:crypto';
import { Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import {
  followDelivery,
  startTracking,
  updateTracking,
} from '../../src/modules/tracking/domain/tracked-delivery';
import { PrismaTrackingRepository } from '../../src/modules/tracking/infrastructure/prisma-tracking.repository';
import { ok } from '@mondapac-drive/shared-kernel';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The tracking repository on PostgreSQL, through the platform's unit of work and market guard,
// for both Market fixtures as the application role: a tracked delivery round-trips under the
// version check, breadcrumbs are idempotent per instant, links are found by hash only, the
// purge deletes in batches past the cutoffs, and no Market sees another's rows.

const at = Temporal.Instant.from('2026-11-02T00:00:00Z');
const route = { pickup: { lat: -27.47, lng: 153.02 }, dropoff: { lat: -27.5, lng: 153.05 } };
const newDeliveryId = () => randomUUID() as Id<'Delivery'>;
const hash = () => randomUUID().replaceAll('-', '').padEnd(64, '0');

describe('tracking repository (database integration)', () => {
  let db: Persistence;
  let repository: PrismaTrackingRepository;

  beforeAll(() => {
    db = createPersistence();
    repository = new PrismaTrackingRepository(db.service);
  });

  afterAll(async () => {
    await db.close();
  });

  const inUnit = <T>(market: MarketContext, work: () => Promise<T>, readOnly = false) =>
    db.unitOfWork
      .run(market, async () => ok(await work()), readOnly ? { readOnly: true } : {})
      .then((result) => (result.ok ? result.value : Promise.reject(new Error('err'))));

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));

    it('saves a tracked delivery, updates it under the version check, and isolates Markets', async () => {
      const deliveryId = newDeliveryId();
      const started = startTracking(
        { ...route, deliveryId, status: 'ASSIGNED', courierId: 'c-1', vehicle: 'car' },
        at,
      );
      await inUnit(market, () => repository.saveDelivery(market, started));
      expect(await inUnit(market, () => repository.findDelivery(market, deliveryId), true)).toEqual(
        started,
      );
      expect(
        await inUnit(other, () => repository.findDelivery(other, deliveryId), true),
      ).toBeUndefined();

      const moved = updateTracking(
        started,
        { status: 'DELIVERED', courierId: 'c-1', vehicle: 'car' },
        at.add({ minutes: 9 }),
      );
      if (!moved.ok) throw new Error('unreachable');
      await inUnit(market, () => repository.saveDelivery(market, moved.value));
      expect(await inUnit(market, () => repository.findDelivery(market, deliveryId), true)).toEqual(
        moved.value,
      );

      await expect(
        inUnit(market, () => repository.saveDelivery(market, moved.value)),
      ).rejects.toThrow(StaleAggregateError);
      await expect(inUnit(market, () => repository.saveDelivery(market, started))).rejects.toThrow(
        StaleAggregateError,
      );
    });

    it('round-trips the delivery version a lifecycle event applied (handoff 26)', async () => {
      const deliveryId = newDeliveryId();
      const booked = followDelivery(
        undefined,
        deliveryId,
        { deliveryVersion: 1, status: 'DISPATCHING' },
        { ...route, vehicle: 'van' },
        at,
      );
      if (!booked.ok) throw new Error('not started');
      await inUnit(market, () => repository.saveDelivery(market, booked.value));
      const assigned = followDelivery(
        booked.value,
        deliveryId,
        { deliveryVersion: 2, status: 'ASSIGNED', courierId: 'c-2' },
        undefined,
        at.add({ minutes: 1 }),
      );
      if (!assigned.ok) throw new Error('refused');
      await inUnit(market, () => repository.saveDelivery(market, assigned.value));
      expect(await inUnit(market, () => repository.findDelivery(market, deliveryId), true)).toEqual(
        assigned.value,
      );
    });

    it("lists the courier's active deliveries only", async () => {
      const courier = `c-${randomUUID().slice(0, 8)}`;
      const active = startTracking(
        { ...route, deliveryId: newDeliveryId(), status: 'PICKED_UP', courierId: courier },
        at,
      );
      const ended = startTracking(
        { ...route, deliveryId: newDeliveryId(), status: 'DELIVERED', courierId: courier },
        at,
      );
      await inUnit(market, async () => {
        await repository.saveDelivery(market, active);
        await repository.saveDelivery(market, ended);
      });
      const found = await inUnit(
        market,
        () => repository.activeDeliveriesOf(market, courier),
        true,
      );
      expect(found.map((d) => d.deliveryId)).toEqual([active.deliveryId]);
      expect(
        await inUnit(other, () => repository.activeDeliveriesOf(other, courier), true),
      ).toEqual([]);
    });

    it('appends breadcrumbs once per instant and reads the trail in order', async () => {
      const deliveryId = newDeliveryId();
      const crumb = (seconds: number, lat: number) => ({
        deliveryId,
        courierId: 'c-1',
        point: { lat, lng: 153.02 },
        accuracyMetres: 9,
        recordedAt: at.add({ seconds }),
      });
      await inUnit(market, () =>
        repository.appendBreadcrumbs(market, [crumb(10, -27.48), crumb(0, -27.47)]),
      );
      await inUnit(market, () => repository.appendBreadcrumbs(market, [crumb(10, -27.48)]));
      const trail = await inUnit(market, () => repository.trailOf(market, deliveryId, 100), true);
      expect(trail).toEqual([crumb(0, -27.47), crumb(10, -27.48)]);
      expect(await inUnit(other, () => repository.trailOf(other, deliveryId, 100), true)).toEqual(
        [],
      );
    });

    it('finds a link by its hash in its own Market only', async () => {
      const link = {
        tokenHash: hash(),
        deliveryId: newDeliveryId(),
        createdAt: at,
        expiresAt: at.add({ hours: 1 }),
      };
      await inUnit(market, () => repository.insertLink(market, link));
      expect(await inUnit(market, () => repository.findLink(market, link.tokenHash), true)).toEqual(
        link,
      );
      expect(
        await inUnit(other, () => repository.findLink(other, link.tokenHash), true),
      ).toBeUndefined();
    });

    it('purges in batches past the cutoffs and keeps newer rows and other Markets', async () => {
      const old = at.subtract({ hours: 24 * 400 });
      const deliveryId = newDeliveryId();
      const crumbs = Array.from({ length: 5 }, (_, i) => ({
        deliveryId,
        courierId: 'c-1',
        point: { lat: -27.47, lng: 153.02 },
        accuracyMetres: 5,
        recordedAt: old.add({ seconds: i }),
      }));
      const fresh = { ...crumbs[0]!, recordedAt: at };
      const ended = startTracking({ ...route, deliveryId, status: 'DELIVERED' }, old);
      const expired = {
        tokenHash: hash(),
        deliveryId,
        createdAt: old,
        expiresAt: old.add({ hours: 1 }),
      };
      for (const m of [market, other]) {
        await inUnit(m, async () => {
          await repository.appendBreadcrumbs(m, [...crumbs, fresh]);
          await repository.saveDelivery(m, ended);
          await repository.insertLink(m, expired);
        });
      }
      const cutoffs = {
        breadcrumbsBefore: at.subtract({ hours: 24 }),
        deliveriesEndedBefore: at.subtract({ hours: 24 }),
        linksExpiredBefore: at,
      };
      // Other runs of this file leave old rows too, so only lower bounds are certain.
      const first = await inUnit(market, () => repository.purge(market, cutoffs, 2));
      expect(first.breadcrumbs).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < 20; i += 1)
        await inUnit(market, () => repository.purge(market, cutoffs, 1000));

      expect(await inUnit(market, () => repository.trailOf(market, deliveryId, 100), true)).toEqual(
        [fresh],
      );
      expect(
        await inUnit(market, () => repository.findDelivery(market, deliveryId), true),
      ).toBeUndefined();
      expect(
        await inUnit(market, () => repository.findLink(market, expired.tokenHash), true),
      ).toBeUndefined();
      expect(
        await inUnit(other, () => repository.trailOf(other, deliveryId, 100), true),
      ).toHaveLength(6);
      expect(
        await inUnit(other, () => repository.findLink(other, expired.tokenHash), true),
      ).toEqual(expired);
    });
  });
});
