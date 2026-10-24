import { uuidV7, type Id } from '@mondapac-drive/shared-kernel';
import {
  approveCourier,
  changeShift,
  deactivateVehicle,
  rejectDocument,
  submitDocument,
  type CourierState,
} from '../../src/modules/fleet/domain/courier';
import { PrismaCourierRepository } from '../../src/modules/fleet/infrastructure/prisma-courier.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import {
  applicant,
  asDeclared,
  eligibleApplicant,
  fleetRules,
  IN_A_YEAR,
  nextId,
  T0,
} from '../support/fleet-markets';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The courier repository on PostgreSQL, through the platform's unit of work and market guard,
// for both Market fixtures as the application role: a courier round-trips with its vehicles and
// documents, an account has one profile per Market, an update writes the changed children under
// the version check, dispatch's read finds only active online couriers of the area, no Market
// sees another's couriers, and the CHECKs refuse what the domain never writes.

const newId = <K extends string>() =>
  uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))) as Id<K>;

describe('fleet courier repository (database integration)', () => {
  let db: Persistence;
  let repository: PrismaCourierRepository;

  beforeAll(() => {
    db = createPersistence();
    repository = new PrismaCourierRepository(db.service);
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

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const rules = fleetRules.get(market.marketId);
    /** Ids from the database's own generator, so parallel runs never collide. */
    const fresh = (courier: CourierState): CourierState => ({ ...courier, id: newId() });
    const eligible = () =>
      eligibleApplicant({ marketId: market.marketId, id: newId(), actorId: `account-${newId()}` });

    it('stores a courier with vehicles and documents and reads it back unchanged', async () => {
      const { courier } = eligible();

      expect(await inUnit(code, () => repository.insert(market, courier))).toEqual({
        ok: true,
        value: true,
      });
      const read = await inUnit(code, () => repository.findById(market, courier.id), true);
      expect(read).toEqual({ ok: true, value: courier });
      const byActor = await inUnit(
        code,
        () => repository.findByActorId(market, courier.actorId),
        true,
      );
      expect(byActor).toEqual({ ok: true, value: courier });
    });

    it('keeps one profile per account and Market', async () => {
      const first = fresh(applicant({ marketId: market.marketId, actorId: `account-${newId()}` }));
      const second = { ...first, id: newId<'Courier'>() };

      await inUnit(code, () => repository.insert(market, first));
      expect(await inUnit(code, () => repository.insert(market, second))).toEqual({
        ok: true,
        value: false,
      });
    });

    it('saves the changed courier, vehicles and documents under the version check', async () => {
      const { courier, vehicleId } = eligible();
      await inUnit(code, () => repository.insert(market, courier));

      const approved = approveCourier(courier, asDeclared(courier), rules, T0).courier;
      const online = changeShift(approved, 'online', rules, T0).courier;
      const offline = changeShift(online, 'offline', rules, T0).courier;
      const retired = deactivateVehicle(offline, vehicleId).courier;
      const docId = nextId<'CourierDocument'>();
      const withNew = submitDocument(
        retired,
        {
          id: docId,
          type: rules.documents.find((d) => !d.perVehicle && d.expires)!.type,
          fileKey: `fleet/${code}/${courier.id}/${docId}`,
          mediaType: 'image/png',
          expiresAt: IN_A_YEAR,
        },
        rules,
        T0,
      ).courier;
      const rejected = rejectDocument(withNew, docId, 'illegible', T0).courier;

      for (const step of [approved, online, offline, retired, withNew, rejected]) {
        await inUnit(code, () => repository.update(market, step));
      }
      const read = await inUnit(code, () => repository.findById(market, courier.id), true);
      expect(read).toEqual({ ok: true, value: rejected });

      // A writer that read an older version loses.
      await expect(inUnit(code, () => repository.update(market, approved))).rejects.toThrow(
        StaleAggregateError,
      );
    });

    it('finds the active online couriers of an area for dispatch, with their documents', async () => {
      const area = `area-${newId()}`.slice(0, 40);
      const make = () => {
        const { courier } = eligibleApplicant({
          marketId: market.marketId,
          id: newId(),
          actorId: `account-${newId()}`,
          serviceAreaCode: area,
        });
        return approveCourier(courier, asDeclared(courier), rules, T0).courier;
      };
      const onlineOne = make();
      const offlineOne = make();
      const pausedOne = make();
      for (const courier of [onlineOne, offlineOne, pausedOne]) {
        await inUnit(code, () => repository.insert(market, { ...courier, version: 1 }));
      }
      const goOnline = (courier: CourierState) =>
        changeShift({ ...courier, version: 1 }, 'online', rules, T0).courier;
      await inUnit(code, () => repository.update(market, goOnline(onlineOne)));
      const pausedOnline = goOnline(pausedOne);
      await inUnit(code, () => repository.update(market, pausedOnline));
      await inUnit(code, () =>
        repository.update(market, changeShift(pausedOnline, 'paused', rules, T0).courier),
      );

      const found = await inUnit(code, () => repository.findOnlineInArea(market, area), true);
      expect(found.ok && found.value.map((c) => c.id)).toEqual([onlineOne.id]);
      expect(found.ok && found.value[0]!.documents.length).toBe(onlineOne.documents.length);

      // Another Market never sees them.
      const other = marketOf(otherMarketOf(code));
      const elsewhere = await db.unitOfWork.run(
        other,
        async () => ({ ok: true as const, value: await repository.findOnlineInArea(other, area) }),
        { readOnly: true },
      );
      expect(elsewhere).toEqual({ ok: true, value: [] });
      const byId = await db.unitOfWork.run(
        other,
        async () => ({
          ok: true as const,
          value: await repository.findById(other, onlineOne.id),
        }),
        { readOnly: true },
      );
      expect(byId).toEqual({ ok: true, value: undefined });
    });

    it('refuses a document naming the vehicle of another courier (foreign key)', async () => {
      const owner = eligible();
      const other = eligible();
      await inUnit(code, () => repository.insert(market, owner.courier));
      await inUnit(code, () => repository.insert(market, other.courier));

      const forged = other.courier.documents.find((d) => d.vehicleId !== undefined)!;
      const docId = nextId<'CourierDocument'>();
      const tampered: CourierState = {
        ...other.courier,
        version: other.courier.version + 1,
        documents: [
          ...other.courier.documents,
          {
            ...forged,
            id: docId,
            vehicleId: owner.vehicleId,
            fileKey: `fleet/${code}/${other.courier.id}/${docId}`,
          },
        ],
      };
      await expect(inUnit(code, () => repository.update(market, tampered))).rejects.toThrow();
    });

    it('refuses a shift for a courier who is not active (CHECK)', async () => {
      const courier = fresh(
        applicant({ marketId: market.marketId, actorId: `account-${newId()}` }),
      );
      await inUnit(code, () => repository.insert(market, courier));

      await expect(
        inUnit(code, () => repository.update(market, { ...courier, shift: 'online', version: 2 })),
      ).rejects.toThrow();
    });
  });
});
