import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { uuidV7, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { FleetDirectory } from '../../src/modules/fleet';
import { ChangeShift } from '../../src/modules/fleet/application/change-shift';
import { AddVehicle, DeactivateVehicle } from '../../src/modules/fleet/application/manage-vehicles';
import {
  ApproveCourier,
  ReinstateCourier,
  SuspendCourier,
} from '../../src/modules/fleet/application/operator-decisions';
import { RegisterCourier } from '../../src/modules/fleet/application/register-courier';
import { VerifyCourierDocument } from '../../src/modules/fleet/application/review-document';
import { SubmitCourierDocument } from '../../src/modules/fleet/application/submit-document';
import type { CourierState } from '../../src/modules/fleet/domain/courier';
import { requirementApplies } from '../../src/modules/fleet/domain/documents';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OBJECT_STORE, type ObjectStore } from '../../src/platform/storage/object-store';
import {
  asDeclared,
  fleetRules,
  IN_A_YEAR,
  T0,
  TEST_SERVICE_AREAS,
} from '../support/fleet-markets';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The fleet use cases on the booted application and the real database, for both Market
// fixtures: a person applies, adds a van and uploads every document the Market asks for; an
// operator verifies them (audited) and approves the courier (audited); the courier goes online
// (an outbox event) and dispatch finds them; a suspension takes them out of dispatch's pool;
// once a document has expired by the Clock they cannot go online. Only the courier themself
// changes their own profile, and only an operator decides about it.

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  put(key: string, bytes: Buffer) {
    this.objects.set(key, bytes);
    return Promise.resolve();
  }
  get(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

/** Jest's asymmetric matcher, typed for object literals. */
const containing = (shape: object): unknown => expect.objectContaining(shape);

const newId = <K extends string>() =>
  uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))) as Id<K>;

function value<T>(result: Result<T, { code: string }>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('fleet use cases (database integration)', () => {
  const clock = new FixedClock(T0);
  const files = new MemoryObjectStore();
  let app: INestApplicationContext;
  let sql: Client;
  const use = <T>(type: new (...args: never[]) => T): T => app.get(type, { strict: false });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(OBJECT_STORE)
      .useValue(files)
      .compile();
    app = await moduleRef.init();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const rules = fleetRules.get(market.marketId);
    const area = TEST_SERVICE_AREAS[code]!;

    const person = (population: 'courier' | 'admin', correlation: string): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: newId(),
          sessionId: newId(),
          merchantId: null,
        }),
        `fleet-${correlation}-${newId()}`,
      );
    const system = () => testCallContext(market, 'system', `fleet-dispatch-${newId()}`);

    async function outboxOf(courierId: string) {
      const { rows } = await sql.query<{ type: string; payload: unknown; version: number }>(
        `SELECT type, payload, aggregate_version AS version FROM fleet.outbox
          WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [code, courierId],
      );
      return rows;
    }

    async function auditOf(correlationId: string) {
      const { rows } = await sql.query<{
        action: string;
        actor_id: string;
        target_id: string;
        after: unknown;
      }>(
        `SELECT action, actor_id, target_id, after FROM platform.audit_log
          WHERE market_id = $1 AND correlation_id = $2 ORDER BY occurred_at, id`,
        [code, correlationId],
      );
      return rows;
    }

    /** A contractor with a refrigerated van and every document verified, still an applicant. */
    async function readyApplicant(courierContext: CallContext, operator: CallContext) {
      const registered = value(
        await use(RegisterCourier).execute(courierContext, {
          employmentType: 'contractor',
          serviceAreaCode: area,
          coldChainCapable: true,
        }),
      );
      expect(registered.created).toBe(true);
      const courierId = registered.courier.id;
      const withVan = value(
        await use(AddVehicle).execute(courierContext, courierId, {
          type: 'van',
          plate: 'FLT 001',
          maxWeightGrams: 300_000,
          maxVolumeLitres: 2000,
          coldBox: 'refrigerated',
        }),
      );
      const van = withVan.vehicles[0]!;
      let courier: CourierState = withVan;
      for (const requirement of rules.documents) {
        if (!requirementApplies(requirement, 'contractor', van, true)) continue;
        const submitted = value(
          await use(SubmitCourierDocument).execute(courierContext, courierId, {
            type: requirement.type,
            ...(requirement.perVehicle ? { vehicleId: van.id } : {}),
            ...(requirement.expires ? { expiresAt: IN_A_YEAR } : {}),
            file: PDF,
          }),
        );
        const document = submitted.courier.documents.find((d) => d.id === submitted.documentId)!;
        expect(files.objects.get(document.fileKey)).toEqual(PDF);
        courier = value(
          await use(VerifyCourierDocument).execute(
            operator,
            courierId,
            submitted.documentId,
            requirement.expires ? IN_A_YEAR : undefined,
          ),
        );
      }
      return courier;
    }

    it('takes a courier from application to dispatch, with events and audit rows', async () => {
      const courierContext = person('courier', 'courier');
      const operator = person('admin', 'operator');
      const applicant = await readyApplicant(courierContext, operator);
      expect(applicant.documents.every((d) => d.status === 'verified')).toBe(true);

      const verifications = await auditOf(operator.correlationId);
      expect(verifications.map((row) => row.action)).toEqual(
        applicant.documents.map(() => 'fleet.document.verified'),
      );
      // One row per document, each naming the operator and the courier (the clock is fixed, so
      // rows of one instant are compared as a set).
      expect(verifications.map((row) => row.target_id).sort()).toEqual(
        applicant.documents.map((d) => d.id).sort(),
      );
      for (const row of verifications) {
        expect(row).toMatchObject({
          actor_id: operator.actor.kind === 'authenticated' ? operator.actor.accountId : null,
          after: containing({ courierId: applicant.id }),
        });
      }

      const approver = person('admin', 'approver');
      const terms = { employmentType: 'contractor' as const, coldChainCapable: true };
      const approved = value(await use(ApproveCourier).execute(approver, applicant.id, terms));
      expect(approved.status).toBe('active');
      expect((await auditOf(approver.correlationId)).map((row) => row.after)).toEqual([
        { status: 'active', ...terms },
      ]);

      const online = value(await use(ChangeShift).execute(courierContext, applicant.id, 'online'));
      expect(online.shift).toBe('online');
      expect(await outboxOf(applicant.id)).toEqual([
        {
          type: 'fleet.courier-went-online.v1',
          payload: { courierId: applicant.id },
          version: online.version,
        },
      ]);

      const directory = use(FleetDirectory);
      const ask = { vehicleTypes: ['van'] as const, coldChain: true, serviceArea: area };
      expect(await directory.findEligibleCouriers(system(), ask)).toContain(applicant.id);
      expect(
        await directory.findEligibleCouriers(system(), { ...ask, vehicleTypes: ['bicycle'] }),
      ).not.toContain(applicant.id);

      const suspended = value(
        await use(SuspendCourier).execute(person('admin', 'suspend'), applicant.id, 'documents'),
      );
      expect(suspended).toMatchObject({ status: 'suspended', shift: 'offline' });
      expect((await outboxOf(applicant.id)).map((row) => [row.type, row.payload])).toEqual([
        ['fleet.courier-went-online.v1', { courierId: applicant.id }],
        ['fleet.courier-suspended.v1', { courierId: applicant.id, wasOnline: true }],
      ]);
      expect(await directory.findEligibleCouriers(system(), ask)).not.toContain(applicant.id);

      // Reinstated after the documents expired: the Clock keeps them offline.
      value(await use(ReinstateCourier).execute(person('admin', 'reinstate'), applicant.id));
      clock.set(IN_A_YEAR.add({ hours: 1 }));
      try {
        const refused = await use(ChangeShift).execute(courierContext, applicant.id, 'online');
        expect(refused).toEqual({
          ok: false,
          error: containing({ code: 'fleet.courier.not-eligible' }),
        });
      } finally {
        clock.set(T0);
      }
    });

    it('answers a second application of the same account with the same profile', async () => {
      const courierContext = person('courier', 'again');
      const input = {
        employmentType: 'employee' as const,
        serviceAreaCode: area,
        coldChainCapable: false,
      };
      const first = value(await use(RegisterCourier).execute(courierContext, input));
      const second = value(await use(RegisterCourier).execute(courierContext, input));

      expect(second).toEqual({ courier: first.courier, created: false });
      expect(
        await use(RegisterCourier).execute(courierContext, {
          ...input,
          serviceAreaCode: 'nowhere',
        }),
      ).toEqual({
        ok: false,
        error: containing({ code: 'fleet.service-area.unknown' }),
      });
    });

    it('lets only the courier change their profile and only an operator decide about it', async () => {
      const courierContext = person('courier', 'owner');
      const stranger = person('courier', 'stranger');
      const { courier } = value(
        await use(RegisterCourier).execute(courierContext, {
          employmentType: 'contractor',
          serviceAreaCode: area,
          coldChainCapable: false,
        }),
      );
      const vehicle = {
        type: 'van' as const,
        plate: 'OWN1',
        maxWeightGrams: 1000,
        maxVolumeLitres: 10,
        coldBox: 'none' as const,
      };
      const notFound = {
        ok: false,
        error: containing({ code: 'fleet.courier.not-found' }),
      };
      const forbidden = { ok: false, error: containing({ code: 'fleet.forbidden' }) };

      expect(await use(AddVehicle).execute(stranger, courier.id, vehicle)).toEqual(notFound);
      expect(
        await use(SubmitCourierDocument).execute(stranger, courier.id, {
          type: rules.documents[0]!.type,
          file: PDF,
        }),
      ).toEqual(notFound);
      expect(
        await use(ApproveCourier).execute(courierContext, courier.id, asDeclared(courier)),
      ).toEqual(forbidden);
      expect(await use(ApproveCourier).execute(system(), courier.id, asDeclared(courier))).toEqual(
        forbidden,
      );
      expect(
        await use(RegisterCourier).execute(system(), {
          employmentType: 'employee',
          serviceAreaCode: area,
          coldChainCapable: false,
        }),
      ).toEqual(forbidden);
    });

    it('audits a vehicle an operator takes out of use, and not one the courier does', async () => {
      const courierContext = person('courier', 'vehicles');
      const { courier } = value(
        await use(RegisterCourier).execute(courierContext, {
          employmentType: 'employee',
          serviceAreaCode: area,
          coldChainCapable: false,
        }),
      );
      const vehicle = (plate: string) => ({
        type: 'van' as const,
        plate,
        maxWeightGrams: 1000,
        maxVolumeLitres: 10,
        coldBox: 'none' as const,
      });
      await use(AddVehicle).execute(courierContext, courier.id, vehicle('VAN1'));
      const both = value(
        await use(AddVehicle).execute(courierContext, courier.id, vehicle('VAN2')),
      );
      const [first, second] = both.vehicles;

      value(await use(DeactivateVehicle).execute(courierContext, courier.id, first!.id));
      expect(await auditOf(courierContext.correlationId)).toEqual([]);

      const operator = person('admin', 'vehicle-off');
      value(await use(DeactivateVehicle).execute(operator, courier.id, second!.id));
      expect(await auditOf(operator.correlationId)).toEqual([
        expect.objectContaining({
          action: 'fleet.vehicle.deactivated',
          target_id: second!.id,
          after: { courierId: courier.id },
        }),
      ]);
    });

    it('keeps no file of a refused document, and reads the file type from its bytes', async () => {
      const courierContext = person('courier', 'files');
      const { courier } = value(
        await use(RegisterCourier).execute(courierContext, {
          employmentType: 'contractor',
          serviceAreaCode: area,
          coldChainCapable: false,
        }),
      );
      const before = files.objects.size;

      expect(
        await use(SubmitCourierDocument).execute(courierContext, courier.id, {
          type: 'library_card',
          file: PDF,
        }),
      ).toEqual({
        ok: false,
        error: containing({ code: 'fleet.document.type-unknown' }),
      });
      expect(
        await use(SubmitCourierDocument).execute(courierContext, courier.id, {
          type: rules.documents[0]!.type,
          file: Buffer.from('<html>not a document</html>'),
        }),
      ).toEqual({
        ok: false,
        error: containing({ code: 'fleet.document.media-type' }),
      });
      expect(files.objects.size).toBe(before);
    });
  });
});
