import { randomUUID } from 'node:crypto';
import type { Id } from '@mondapac-drive/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac-drive/shared-kernel/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { FleetDirectory } from '../../src/modules/fleet';
import { SweepDocumentFiles } from '../../src/modules/fleet/application/use-cases/sweep-document-files.use-case';
import { requirementApplies } from '../../src/modules/fleet/domain/documents';
import { CLOCK } from '../../src/platform/clock/clock.module';
import {
  RATE_LIMIT_COUNTERS,
  type RateLimitCounters,
} from '../../src/platform/rate-limit/rate-limit-counters';
import { MemoryObjectStore } from '../../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../../src/platform/storage/object-store';
import { fleetRules, IN_A_YEAR, T0, TEST_SERVICE_AREAS } from '../support/fleet-markets';
import { createTestApp, type LogLine } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type AdminActor, type CourierActor } from './actor-support';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Fleet on the real application and database, for both Market fixtures, with real credentials.
// A courier applies, adds a van and uploads every document the Market asks for (multipart); a
// dispatcher verifies them and approves the courier (each audited); the courier goes online (an
// outbox event) and dispatch finds them by their account id; an operator may look but not decide;
// a suspension takes them out of dispatch's pool. Files are downloaded as attachments by their
// owner or an admin only, no response carries the account id or a storage key, and the sweep
// removes stored files no document names.

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const containing = (shape: object): unknown => expect.objectContaining(shape);

/** The flow sends more requests than ZZ's per-minute limit; the limiter has its own suites. */
const unlimited: RateLimitCounters = {
  consume: () => Promise.resolve({ count: 1, msBeforeNext: 60_000 }),
};

describe('fleet API (database integration)', () => {
  const clock = new FixedClock(T0);
  const files = new MemoryObjectStore(() => clock.now());
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let sql: Client;

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({
      panelOrigins: true,
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(OBJECT_STORE)
          .useValue(files)
          .overrideProvider(RATE_LIMIT_COUNTERS)
          .useValue(unlimited),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const rules = fleetRules.get(market.marketId);
    const area = TEST_SERVICE_AREAS[code]!;
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const system = () => testCallContext(market, 'system', `fleet-api-${randomUUID()}`);
    let dispatcher: AdminActor;
    let operator: AdminActor;
    let elsewhere: AdminActor;
    let courier: CourierActor;
    let stranger: CourierActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      const origin = panelHeaders(code).origin;
      dispatcher = await actors.admin(origin, 'dispatcher');
      operator = await actors.admin(origin, 'operator');
      courier = await actors.courier();
      stranger = await actors.courier();
      const otherActors = new TestActors(app, other);
      await otherActors.seedRoles();
      elsewhere = await otherActors.admin(panelHeaders(other).origin, 'dispatcher');
    });

    const as = (headers: object, market = code) => ({ 'x-market-id': market, ...headers });

    async function auditOf(actorId: string, action: string) {
      const { rows } = await sql.query<{ target_id: string; before: unknown; after: unknown }>(
        `SELECT target_id, before, after FROM platform.audit_log
          WHERE market_id = $1 AND actor_id = $2 AND action = $3 ORDER BY occurred_at, id`,
        [code, actorId, action],
      );
      return rows;
    }

    async function outboxOf(courierId: string) {
      const { rows } = await sql.query<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM fleet.outbox
          WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [code, courierId],
      );
      return rows.map((row) => [row.type, row.payload]);
    }

    const upload = (actor: CourierActor, fields: Record<string, string>, file = PDF) => {
      let call = http().post('/fleet/courier/me/documents').set(as(actor.headers));
      for (const [name, value] of Object.entries(fields)) call = call.field(name, value);
      return call.attach('file', file, { filename: 'scan.pdf', contentType: 'application/pdf' });
    };

    it('takes a courier from application to dispatch over HTTP, audited and with events', async () => {
      const applied = await http()
        .post('/fleet/courier/me')
        .set(as(courier.headers))
        .send({ employmentType: 'contractor', serviceAreaCode: area, coldChainCapable: true });
      expect(applied.status).toBe(201);
      expect(applied.body).toMatchObject({ status: 'applicant', shift: 'offline' });
      const courierId = (applied.body as { id: Id<'Courier'> }).id;
      const again = await http()
        .post('/fleet/courier/me')
        .set(as(courier.headers))
        .send({ employmentType: 'contractor', serviceAreaCode: area, coldChainCapable: true });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: courierId });

      const settings = await http().get('/fleet/courier/me/settings').set(as(courier.headers));
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({
        marketId: code,
        offerAcceptSeconds: expect.any(Number) as number,
        coldChain: { chilled: containing({}), frozen: containing({}) },
      });

      const withVan = await http()
        .post('/fleet/courier/me/vehicles')
        .set(as(courier.headers))
        .send({ type: 'van', plate: 'FLT 001', coldBox: 'refrigerated' });
      expect(withVan.status).toBe(201);
      const van = (withVan.body as { vehicles: { id: string; maxWeightGrams: number }[] })
        .vehicles[0]!;
      expect(van.maxWeightGrams).toBe(rules.vehicleClasses.van!.maxWeightGrams);

      const documentIds: string[] = [];
      for (const requirement of rules.documents) {
        const vehicle = { id: van.id, type: 'van', coldBox: 'refrigerated', active: true };
        if (!requirementApplies(requirement, 'contractor', vehicle as never, true)) continue;
        const sent = await upload(courier, {
          type: requirement.type,
          ...(requirement.perVehicle ? { vehicleId: van.id } : {}),
          ...(requirement.expires ? { expiresAt: IN_A_YEAR.toString() } : {}),
        });
        expect(sent.status).toBe(201);
        documentIds.push((sent.body as { documentId: string }).documentId);
      }
      const [firstDocument] = documentIds;

      // The owner downloads their file as an attachment; another courier cannot.
      const own = await http()
        .get(`/fleet/courier/me/documents/${firstDocument}/file`)
        .set(as(courier.headers))
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(own.status).toBe(200);
      expect(own.headers['content-disposition']).toBe(
        `attachment; filename="${firstDocument}.pdf"`,
      );
      expect(own.headers['x-content-type-options']).toBe('nosniff');
      expect(own.headers['content-type']).toContain('application/pdf');
      expect(own.body).toEqual(PDF);
      const theirs = await http()
        .get(`/fleet/courier/me/documents/${firstDocument}/file`)
        .set(as(stranger.headers));
      expect(theirs.status).toBe(404);

      // An operator may look and download, not review; the dispatcher reviews.
      const base = `/fleet/admin/couriers/${courierId}`;
      expect((await http().get(base).set(as(operator.headers))).status).toBe(200);
      const adminFile = await http()
        .get(`${base}/documents/${firstDocument}/file`)
        .set(as(operator.headers));
      expect(adminFile.status).toBe(200);
      expect(adminFile.headers['content-disposition']).toContain('attachment');
      expect(
        (
          await http()
            .post(`${base}/documents/${firstDocument}/verify`)
            .set(as(operator.headers))
            .send({})
        ).status,
      ).toBe(403);

      const detail = await http().get(base).set(as(dispatcher.headers));
      for (const document of (
        detail.body as { documents: { id: string; expiresAt: string | null }[] }
      ).documents) {
        const verified = await http()
          .post(`${base}/documents/${document.id}/verify`)
          .set(as(dispatcher.headers))
          .send(document.expiresAt === null ? {} : { expiresAt: IN_A_YEAR.toString() });
        expect(verified.status).toBe(200);
      }
      expect(
        (await auditOf(dispatcher.accountId, 'fleet.document.verified'))
          .map((r) => r.target_id)
          .sort(),
      ).toEqual([...documentIds].sort());

      const approved = await http()
        .post(`${base}/approve`)
        .set(as(dispatcher.headers))
        .send({ employmentType: 'contractor', coldChainCapable: true });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'active' });
      const taxed = await http()
        .put(`${base}/tax-registration`)
        .set(as(dispatcher.headers))
        .send({ taxRegistered: true });
      expect(taxed.body).toMatchObject({ taxRegistered: true });
      expect(await auditOf(dispatcher.accountId, 'fleet.courier.tax-registration-set')).toEqual([
        containing({
          target_id: courierId,
          before: { taxRegistered: false },
          after: { taxRegistered: true },
        }),
      ]);

      const claimed = await http()
        .put('/fleet/courier/me/shift')
        .set(as(courier.headers))
        .send({ state: 'on_delivery' });
      expect(claimed.status).toBe(400);

      const online = await http()
        .put('/fleet/courier/me/shift')
        .set(as(courier.headers))
        .send({ state: 'online' });
      expect(online.status).toBe(200);
      expect(online.body).toEqual({ shift: 'online', activeDeliveryId: null });
      expect(await outboxOf(courierId)).toEqual([['fleet.courier-went-online.v1', { courierId }]]);

      const directory = app.get(FleetDirectory);
      const ask = { vehicleTypes: ['van'] as const, coldChain: true, serviceArea: area };
      const available = await directory.findAvailableCouriers(system(), ask);
      expect(available.find((c) => c.courierId === courier.accountId)).toMatchObject({
        idleSince: T0,
        vehicles: [containing({ vehicleId: van.id, type: 'van' })],
      });
      expect(await directory.payeeProfiles(system(), [courier.accountId])).toEqual([
        {
          courierId: courier.accountId,
          employmentType: 'contractor',
          taxRegistered: true,
          businessIdVerified: true,
        },
      ]);

      const measured = await http()
        .put(`${base}/vehicles/${van.id}/capacity`)
        .set(as(dispatcher.headers))
        .send({ maxWeightGrams: 123_000, maxVolumeLitres: 900 });
      expect(measured.status).toBe(200);
      expect(await auditOf(dispatcher.accountId, 'fleet.vehicle.capacity-set')).toEqual([
        containing({
          target_id: van.id,
          after: { courierId, maxWeightGrams: 123_000, maxVolumeLitres: 900 },
        }),
      ]);

      const suspended = await http()
        .post(`${base}/suspend`)
        .set(as(dispatcher.headers))
        .send({ reason: 'documents' });
      expect(suspended.body).toMatchObject({ status: 'suspended', shift: 'offline' });
      expect(await directory.findAvailableCouriers(system(), ask)).not.toContainEqual(
        containing({ courierId: courier.accountId }),
      );
      expect(
        (await http().post(`${base}/reinstate`).set(as(dispatcher.headers))).body,
      ).toMatchObject({ status: 'active' });

      // The list, and no response that names the account or a storage key.
      const list = await http().get('/fleet/admin/couriers?limit=100').set(as(operator.headers));
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect((list.body as { items: { id: string }[] }).items.map((c) => c.id)).toContain(
        courierId,
      );
      const me = await http().get('/fleet/courier/me').set(as(courier.headers));
      for (const body of [me.body, list.body, detail.body, approved.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(courier.accountId);
        expect(text).not.toMatch(/fileKey|actorId|fleet\//);
      }

      // Another Market's dispatcher does not see the courier.
      expect((await http().get(base).set(as(elsewhere.headers, other))).status).toBe(404);
    });

    it('refuses callers without the right session or population', async () => {
      const anonymous = { 'x-market-id': code };
      expect((await http().get('/fleet/courier/me').set(anonymous)).status).toBe(401);
      expect((await http().get('/fleet/admin/couriers').set(anonymous)).status).toBe(401);
      // A courier's bearer token is never read on an admin route.
      expect((await http().get('/fleet/admin/couriers').set(as(stranger.headers))).status).toBe(
        401,
      );
      const unauthenticated = await http()
        .post('/fleet/courier/me/documents')
        .set(anonymous)
        .attach('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
      expect(unauthenticated.status).toBe(401);
      expect(
        (
          await http()
            .put('/fleet/courier/me/shift')
            .set(as(stranger.headers))
            .send({ state: 'nap' })
        ).body,
      ).toMatchObject({ code: 'validation.failed' });
      expect((await http().get('/fleet/courier/me').set(as(stranger.headers))).status).toBe(404);
      expect(
        (await http().get('/fleet/admin/couriers/not-a-uuid').set(as(dispatcher.headers))).status,
      ).toBe(404);
    });

    it('refuses an oversized or non-document upload and keeps no file of it', async () => {
      await http()
        .post('/fleet/courier/me')
        .set(as(stranger.headers))
        .send({ employmentType: 'employee', serviceAreaCode: area, coldChainCapable: false });
      const before = files.objects.size;
      const type = rules.documents[0]!.type;
      const tooLarge = await upload(stranger, { type }, Buffer.alloc(10 * 1024 * 1024 + 1, 0x25));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body).toMatchObject({ code: 'request.body-too-large' });
      const html = await upload(stranger, { type }, Buffer.from('<html>not a document</html>'));
      expect(html.status).toBe(415);
      expect(html.body).toMatchObject({ code: 'fleet.document.media-type' });
      const unknown = await upload(stranger, { type: 'library_card' });
      expect(unknown.body).toMatchObject({ code: 'fleet.document.type-unknown' });
      expect(files.objects.size).toBe(before);
      expect(JSON.stringify(logLines)).not.toContain('%PDF');
    });

    it('sweeps stored files no document names, once they are old enough', async () => {
      const orphan = `fleet/${code}/${randomUUID()}/${randomUUID()}`;
      await files.put(orphan, PDF);
      const kept = [...files.objects.keys()].filter((key) => key.startsWith(`fleet/${code}/`));
      const sweep = app.get(SweepDocumentFiles);
      expect(await sweep.execute(system(), {})).toEqual({
        ok: true,
        value: containing({ removed: 0 }),
      });
      clock.set(T0.add({ minutes: 61 }));
      try {
        const swept = await sweep.execute(system(), {});
        expect(swept).toEqual({ ok: true, value: containing({ removed: 1 }) });
      } finally {
        clock.set(T0);
      }
      expect(files.objects.has(orphan)).toBe(false);
      for (const key of kept.filter((k) => k !== orphan)) expect(files.objects.has(key)).toBe(true);
      expect(
        await sweep.execute(testCallContext(market, 'anonymous', 'fleet-sweep-anon'), {}),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });
});
