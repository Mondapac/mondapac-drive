import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Id } from '@mondapac-drive/shared-kernel';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type AdminActor, type MerchantActor } from './actor-support';
import { testDatabaseUrl } from './test-database';

// The operations panel's two lists on the real application and database, for both Market
// fixtures: the deliveries of the Market (newest first, filtered, paged, without the stops'
// addresses or contacts) and the couriers of the Market (accounts and pending invitations).
// Each needs its view key: a dispatcher and an operator read both, a merchant key and a courier
// read neither, and no Market lists another's rows.

/** A postcode inside an enabled service area of each fixture (config/service-areas). */
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

interface Summary {
  readonly id: string;
  readonly merchantId: string;
  readonly status: string;
  readonly courierId?: string;
  readonly pickupPostcode: string;
  readonly total: { readonly amount: string; readonly currency: string };
}

describe('operations panel lists (database integration)', () => {
  // One application per Market fixture: each has its own in-memory rate-limit counters, so the
  // requests of one fixture never spend the other's budget.
  let app: NestExpressApplication;

  const stop = (code: string, lat: number) => ({
    address: '1 Example St',
    postcode: POSTCODE[code]!,
    point: { lat, lng: 153.02 },
    contactName: 'Sam Example',
    contactPhone: '+61 400 000 000',
  });
  const post = (code: string, path: string, headers: object, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'x-market-id': code, ...headers })
      .send(body);
  const get = (code: string, path: string, headers: object) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((market) => market !== code)!;
    let admin: AdminActor;
    let dispatcher: AdminActor;
    let operator: AdminActor;
    let unrelated: AdminActor;
    let merchant: MerchantActor;
    let otherMerchant: MerchantActor;
    let courierId: string;
    let courierHeaders: Readonly<Record<string, string>>;
    let elsewhere: AdminActor;
    const booked: string[] = [];

    afterAll(async () => {
      await app.close();
    });

    beforeAll(async () => {
      ({ app } = await createTestApp({
        panelOrigins: true,
        env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
      }));
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      const { origin } = panelHeaders(code);
      admin = await actors.admin(origin);
      dispatcher = await actors.admin(origin, 'dispatcher');
      operator = await actors.admin(origin, 'operator');
      // A custom role with neither list's view key (Hassan, WP3 review).
      const role = await post(code, '/identity/admin/roles', admin.headers, {
        name: `Merchants only ${randomUUID().slice(0, 8)}`,
        permissionKeys: ['identity.merchant.view'],
      });
      expect(role.status).toBe(201);
      unrelated = await actors.admin(origin, {
        roleId: (role.body as { roleId: Id<'Role'> }).roleId,
      });
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      otherMerchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      const courier = await actors.courier();
      courierId = courier.accountId;
      courierHeaders = courier.headers;
      const otherActors = new TestActors(app, other);
      await otherActors.seedRoles();
      elsewhere = await otherActors.admin(panelHeaders(other).origin);

      for (const by of [merchant, merchant, otherMerchant]) {
        const created = await post(code, '/delivery/deliveries', by.headers, {
          externalReference: `order-${randomUUID()}`,
          pickup: stop(code, -27.47),
          dropoff: stop(code, -27.49),
          parcel: { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' },
          mode: 'on_demand',
        });
        expect(created.status).toBe(201);
        booked.push((created.body as { id: string }).id);
      }
      const vehicle = (
        (await get(code, `/delivery/admin/deliveries/${booked[0]}`, admin.headers)).body as {
          quote: { vehicle: string };
        }
      ).quote.vehicle;
      const assigned = await post(
        code,
        `/delivery/admin/deliveries/${booked[0]}/dispatch`,
        dispatcher.headers,
        { type: 'courier_assigned', courierId, vehicle },
      );
      expect(assigned.status).toBe(200);
    });

    const list = async (query: string, by: AdminActor = dispatcher) => {
      const response = await get(code, `/delivery/admin/deliveries${query}`, by.headers);
      expect(response.status).toBe(200);
      return response.body as { items: Summary[]; next: string | null };
    };

    it('lists the deliveries newest first, in the Market currency, without stop contacts', async () => {
      const response = await get(code, '/delivery/admin/deliveries?limit=100', dispatcher.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const { items } = response.body as { items: Summary[] };
      const ids = items.map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining(booked));
      expect(ids.indexOf(booked[2]!)).toBeLessThan(ids.indexOf(booked[0]!));
      const row = items.find((item) => item.id === booked[0])!;
      expect(row).toMatchObject({ status: 'ASSIGNED', courierId, pickupPostcode: POSTCODE[code] });
      expect(row.total.currency).toBe(code === 'AU' ? 'AUD' : 'JPY');
      const text = JSON.stringify(items);
      expect(text).not.toContain('Sam Example');
      expect(text).not.toContain('1 Example St');
    });

    it('filters by status, merchant and courier', async () => {
      const assigned = await list(`?status=ASSIGNED&courierId=${courierId}`);
      expect(assigned.items.map((row) => row.id)).toEqual([booked[0]]);

      const theirs = await list(`?merchantId=${otherMerchant.merchantId}`);
      expect(theirs.items.map((row) => row.id)).toEqual([booked[2]]);

      const waiting = await list(`?status=DISPATCHING,SCHEDULED&merchantId=${merchant.merchantId}`);
      expect(waiting.items.map((row) => row.id)).toEqual([booked[1]]);
    });

    it('pages with before and limit', async () => {
      const first = await list(`?merchantId=${merchant.merchantId}&limit=1`);
      expect(first.items.map((row) => row.id)).toEqual([booked[1]]);
      expect(first.next).toBe(booked[1]);

      const second = await list(`?merchantId=${merchant.merchantId}&limit=1&before=${first.next}`);
      expect(second.items.map((row) => row.id)).toEqual([booked[0]]);
      expect(second.next).toBeNull();
    });

    it('refuses a malformed query with the fields at fault (400)', async () => {
      for (const query of ['?status=LOST', '?limit=0', '?limit=101', '?before=x', '?colour=red']) {
        const response = await get(code, `/delivery/admin/deliveries${query}`, admin.headers);
        expect([query, response.status]).toEqual([query, 400]);
        expect(response.body).toMatchObject({ code: 'validation.failed' });
      }
    });

    it('lets an operator read the list and refuses a merchant key or a courier', async () => {
      await list('?status=ASSIGNED', operator);
      for (const headers of [merchant.headers, courierHeaders]) {
        const response = await get(code, '/delivery/admin/deliveries', headers);
        expect(response.status).toBe(401);
      }
    });

    it('refuses both lists to an admin whose role lacks their view keys (403)', async () => {
      for (const path of ['/delivery/admin/deliveries', '/identity/admin/couriers']) {
        const response = await get(code, path, unrelated.headers);
        expect([path, response.status]).toEqual([path, 403]);
      }
    });

    it('lists no delivery of another Market', async () => {
      const response = await get(
        other,
        '/delivery/admin/deliveries?status=DISPATCHING,ASSIGNED&limit=100',
        elsewhere.headers,
      );

      expect(response.status).toBe(200);
      const ids = (response.body as { items: Summary[] }).items.map((row) => row.id);
      for (const id of booked) expect(ids).not.toContain(id);
    });

    it('lists the couriers and pending courier invitations to a dispatcher and an operator', async () => {
      const email = `courier-${randomUUID()}@example.com`;
      const invited = await post(code, '/identity/admin/couriers/invitations', dispatcher.headers, {
        email,
      });
      expect(invited.status).toBe(201);

      for (const by of [dispatcher, operator]) {
        const response = await get(code, '/identity/admin/couriers?limit=100', by.headers);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const { items } = response.body as {
          items: { type: string; accountId?: string; email: string; status: string }[];
        };
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'account', accountId: courierId, status: 'active' }),
            expect.objectContaining({ type: 'invitation', email, status: 'pending' }),
          ]),
        );
        // Admin accounts are never in the courier list.
        expect(items.map((row) => row.accountId)).not.toContain(dispatcher.accountId);
      }
    });

    it('shows a disabled courier as disabled', async () => {
      const actors = new TestActors(app, code);
      const courier = await actors.courier();
      const disabled = await post(
        code,
        `/identity/admin/couriers/${courier.accountId}/disable`,
        dispatcher.headers,
        {},
      );
      expect(disabled.status).toBe(200);

      const response = await get(code, '/identity/admin/couriers?limit=100', operator.headers);
      const row = (response.body as { items: { accountId?: string; status: string }[] }).items.find(
        (item) => item.accountId === courier.accountId,
      );
      expect(row?.status).toBe('disabled');
    });

    it('pages the courier list and refuses a malformed query (400)', async () => {
      const first = await get(code, '/identity/admin/couriers?limit=1', dispatcher.headers);
      expect(first.status).toBe(200);
      const { items, next } = first.body as { items: unknown[]; next: string | null };
      expect(items).toHaveLength(1);
      expect(next).not.toBeNull();
      const second = await get(
        code,
        `/identity/admin/couriers?limit=1&after=${next}`,
        dispatcher.headers,
      );
      expect(second.status).toBe(200);

      for (const query of ['?limit=0', '?limit=101', '?after=x', '?colour=red']) {
        const response = await get(code, `/identity/admin/couriers${query}`, dispatcher.headers);
        expect([query, response.status]).toEqual([query, 400]);
      }
    });

    it('refuses the courier list to a merchant key and a courier, and shows no courier of another Market', async () => {
      for (const headers of [merchant.headers, courierHeaders]) {
        const response = await get(code, '/identity/admin/couriers', headers);
        expect(response.status).toBe(401);
      }
      const response = await get(other, '/identity/admin/couriers?limit=100', elsewhere.headers);
      expect(response.status).toBe(200);
      const ids = (response.body as { items: { accountId?: string }[] }).items.map(
        (row) => row.accountId,
      );
      expect(ids).not.toContain(courierId);
    });
  });
});
