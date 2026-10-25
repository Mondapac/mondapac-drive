import { randomUUID } from 'node:crypto';
import type { Id } from '@mondapac-drive/shared-kernel';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type AdminActor, type MerchantActor } from './actor-support';
import { testDatabaseUrl } from './test-database';

// The operator's view of merchant webhook subscriptions on the real application and database,
// for both Market fixtures (handoff 33 PR 2): the operator role (seed v6) lists every merchant's
// or one merchant's subscriptions, newest first, a page at a time, never with a secret; a holder
// of the re-send key alone, a dispatcher, a merchant's API key and an anonymous caller are
// refused; a bad query answers 400.

interface Item {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly [field: string]: unknown;
}
interface Page {
  readonly items: readonly Item[];
  readonly next: string | null;
}

const PATH = '/notifications/admin/webhook-subscriptions';

describe('notifications admin webhook views (database integration)', () => {
  let app: NestExpressApplication;

  const call = (
    code: string,
    method: 'get' | 'post',
    path: string,
    headers: object,
    body?: object,
  ) => {
    const pending = request(app.getHttpServer())
      [method](path)
      .set({ 'x-market-id': code, ...headers });
    return body === undefined ? pending : pending.send(body);
  };

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    let admin: AdminActor;
    let operator: AdminActor;
    let dispatcher: AdminActor;
    let resender: AdminActor;
    let merchant: MerchantActor;
    let other: MerchantActor;
    const created: string[] = [];

    beforeAll(async () => {
      ({ app } = await createTestApp({
        panelOrigins: true,
        env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
      }));
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      const { origin } = panelHeaders(code);
      admin = await actors.admin(origin);
      operator = await actors.admin(origin, 'operator');
      dispatcher = await actors.admin(origin, 'dispatcher');
      const role = await call(code, 'post', '/identity/admin/roles', admin.headers, {
        name: `Webhook resender ${randomUUID().slice(0, 8)}`,
        permissionKeys: ['notifications.webhook-call.resend'],
      });
      expect(role.status).toBe(201);
      resender = await actors.admin(origin, {
        roleId: (role.body as { roleId: Id<'Role'> }).roleId,
      });
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      other = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      for (const [who, n] of [
        [merchant, 1],
        [merchant, 2],
        [merchant, 3],
        [other, 4],
      ] as const) {
        const subscribed = await call(
          code,
          'post',
          '/notifications/webhook-subscriptions',
          who.headers,
          {
            url: `https://hooks${n}.example.com/drive`,
            eventTypes: ['delivery.booked'],
          },
        );
        expect(subscribed.status).toBe(201);
        created.push((subscribed.body as { id: string }).id);
      }
    });

    afterAll(async () => {
      await app.close();
    });

    it("lists one merchant's subscriptions newest first, a page at a time, without secrets", async () => {
      const first = await call(
        code,
        'get',
        `${PATH}?merchantId=${merchant.merchantId}&limit=2`,
        operator.headers,
      );
      expect(first.status).toBe(200);
      const page = first.body as Page;
      expect(page.items.map((item) => item.id)).toEqual([created[2], created[1]]);
      expect(page.next).toBe(created[1]);
      expect(page.items[0]).toEqual({
        id: created[2],
        merchantId: merchant.merchantId,
        url: 'https://hooks3.example.com/drive',
        eventTypes: ['delivery.booked'],
        status: 'active',
        secretVersion: 1,
        previousSecretValidUntil: null,
        createdAt: expect.any(String) as unknown,
      });
      expect(JSON.stringify(page)).not.toMatch(/secret"/);

      const second = await call(
        code,
        'get',
        `${PATH}?merchantId=${merchant.merchantId}&limit=2&after=${page.next}`,
        operator.headers,
      );
      expect(second.body).toEqual({
        items: [expect.objectContaining({ id: created[0] }) as unknown],
        next: null,
      });
    });

    it("lists every merchant's subscriptions of the Market without a filter", async () => {
      const all = await call(code, 'get', `${PATH}?limit=100`, operator.headers);
      expect(all.status).toBe(200);
      const ids = (all.body as Page).items.map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining(created));
      const merchants = new Set((all.body as Page).items.map((item) => item.merchantId));
      expect(merchants.has(other.merchantId)).toBe(true);
    });

    it('refuses a bad query', async () => {
      for (const query of ['limit=0', 'limit=101', 'merchantId=nope', 'after=1', 'extra=1']) {
        expect((await call(code, 'get', `${PATH}?${query}`, operator.headers)).status).toBe(400);
      }
    });

    it('refuses the re-send key alone, a dispatcher, a merchant and an anonymous caller', async () => {
      expect((await call(code, 'get', PATH, resender.headers)).status).toBe(403);
      expect((await call(code, 'get', PATH, dispatcher.headers)).status).toBe(403);
      expect([401, 403]).toContain((await call(code, 'get', PATH, merchant.headers)).status);
      expect([401, 403]).toContain((await call(code, 'get', PATH, {})).status);
    });

    it('lets the re-send key list dead calls, each with its merchant', async () => {
      const dead = await call(
        code,
        'get',
        '/notifications/admin/webhook-calls/dead',
        resender.headers,
      );
      expect(dead.status).toBe(200);
      for (const item of (dead.body as { calls: { merchantId: unknown }[] }).calls) {
        expect(typeof item.merchantId).toBe('string');
      }
    });
  });
});
