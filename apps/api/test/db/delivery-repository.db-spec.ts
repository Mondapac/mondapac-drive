import { geoPoint, Temporal, uuidV7, type Id } from '@mondapac-drive/shared-kernel';
import { applyDeliveryEvent, createDelivery } from '../../src/modules/delivery/domain/delivery';
import type { DeliveryState } from '../../src/modules/delivery/domain/delivery';
import { parcel } from '../../src/modules/delivery/domain/parcel';
import { priceDelivery } from '../../src/modules/delivery/domain/pricing';
import { PrismaDeliveryRepository } from '../../src/modules/delivery/infrastructure/prisma-delivery.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { markets } from '../support/delivery-markets';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The delivery repository on PostgreSQL, through the platform's unit of work and market guard,
// for both Market fixtures as the application role: a booking round-trips with its money as
// bigint and its instants as Temporal, a repeated booking is refused by the idempotency key, an
// update appends history under the version check, and no Market sees another's delivery.

const at = Temporal.Instant.from('2026-11-02T00:00:00Z');
const stop = {
  address: '1 Example St',
  postcode: '1000',
  point: geoPoint(-27.47, 153.02),
  contactName: 'Sam',
  contactPhone: '+61 400 000 000',
};
const newId = () =>
  uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))) as Id<'Delivery'>;

describe('delivery repository (database integration)', () => {
  let db: Persistence;
  let repository: PrismaDeliveryRepository;

  beforeAll(() => {
    db = createPersistence();
    repository = new PrismaDeliveryRepository(db.service);
  });

  afterAll(async () => {
    await db.close();
  });

  function booking(code: string, reference: string): DeliveryState {
    const market = marketOf(code);
    const settings = markets.get(market.marketId);
    const p = parcel(5000, 20, 'ambient');
    return createDelivery({
      id: newId(),
      marketId: market.marketId,
      merchantId: 'merchant-1',
      externalReference: reference,
      serviceAreaCode: 'area-1',
      pickup: stop,
      dropoff: { ...stop, point: geoPoint(-27.5, 153.05) },
      parcel: p,
      mode: 'on_demand',
      quote: priceDelivery(settings, { parcel: p, distanceMetres: 3000, mode: 'on_demand' }),
      createdAt: at,
    });
  }

  const inUnit = <T>(code: string, work: () => Promise<T>, readOnly = false) =>
    db.unitOfWork.run(
      marketOf(code),
      async () => ({ ok: true as const, value: await work() }),
      readOnly ? { readOnly: true } : {},
    );

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);

    it('stores a booking and reads it back unchanged', async () => {
      const delivery = booking(code, `order-${newId()}`);

      expect(await inUnit(code, () => repository.insert(market, delivery))).toEqual({
        ok: true,
        value: true,
      });
      const read = await inUnit(code, () => repository.findById(market, delivery.id), true);

      expect(read.ok && read.value).toEqual(delivery);
      expect(read.ok && typeof read.value?.quote.total.amount).toBe('bigint');
    });

    it('refuses a second booking with the same merchant reference, and finds the first by it', async () => {
      const reference = `order-${newId()}`;
      const first = booking(code, reference);
      await inUnit(code, () => repository.insert(market, first));

      expect(await inUnit(code, () => repository.insert(market, booking(code, reference)))).toEqual(
        { ok: true, value: false },
      );
      const found = await inUnit(
        code,
        () => repository.findByExternalReference(market, 'merchant-1', reference),
        true,
      );
      expect(found.ok && found.value?.id).toBe(first.id);
    });

    it('appends history on update and refuses a stale version', async () => {
      const delivery = booking(code, `order-${newId()}`);
      await inUnit(code, () => repository.insert(market, delivery));
      const settings = markets.get(market.marketId);
      const assigned = applyDeliveryEvent(
        delivery,
        { type: 'courier_assigned', courierId: 'courier-1', vehicle: delivery.quote.vehicle },
        at.add({ minutes: 5 }),
        settings,
      );

      await inUnit(code, () => repository.update(market, assigned));
      const read = await inUnit(code, () => repository.findById(market, delivery.id), true);
      expect(read.ok && read.value).toEqual(assigned);

      await expect(inUnit(code, () => repository.update(market, assigned))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
    });

    it("never shows a delivery to the other Market's unit", async () => {
      const delivery = booking(code, `order-${newId()}`);
      await inUnit(code, () => repository.insert(market, delivery));
      const other = otherMarketOf(code);

      const read = await inUnit(
        other,
        () => repository.findById(marketOf(other), delivery.id),
        true,
      );
      expect(read).toEqual({ ok: true, value: undefined });
    });
  });
});
