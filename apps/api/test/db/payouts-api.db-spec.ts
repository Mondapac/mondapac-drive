import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Id } from '@mondapac-drive/shared-kernel';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type AdminActor, type CourierActor } from './actor-support';
import { testDatabaseUrl } from './test-database';

// The payouts routes on the real application, identity and database, for both Market fixtures
// (Hassan L-d): a courier reads only its own routes, an admin only the admin routes; the admin
// routes need payouts.ledger.view, adjusting and settling also their protected keys, and an
// unsafe admin request without its CSRF token is refused.

describe('payouts routes (database integration)', () => {
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
    let dispatcher: AdminActor;
    let viewer: AdminActor;
    let courier: CourierActor;
    const adjustment = (currency: string) => ({
      amount: { amount: '500', currency },
      reason: 'bonus',
      key: `adj-${randomUUID()}`,
    });
    const currencyOf = (market: string) => (market === 'AU' ? 'AUD' : 'JPY');

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
      // A custom role that may read lines and balances, without the protected keys.
      const role = await call(code, 'post', '/identity/admin/roles', admin.headers, {
        name: `Payouts viewer ${randomUUID().slice(0, 8)}`,
        permissionKeys: ['payouts.ledger.view'],
      });
      expect(role.status).toBe(201);
      viewer = await actors.admin(origin, { roleId: (role.body as { roleId: Id<'Role'> }).roleId });
      courier = await actors.courier();
    });

    afterAll(async () => {
      await app.close();
    });

    it("answers a courier's own summary, and refuses it the admin routes", async () => {
      const summary = await call(code, 'get', '/payouts/courier/me/summary', courier.headers);
      expect(summary.status).toBe(200);
      expect(summary.body).toEqual({
        today: { amount: '0', currency: currencyOf(code) },
        week: { amount: '0', currency: currencyOf(code) },
        deliveriesToday: 0,
      });

      for (const path of [
        '/payouts/admin/lines',
        `/payouts/admin/couriers/${courier.accountId}/balance`,
      ]) {
        const response = await call(code, 'get', path, courier.headers);
        expect([401, 403]).toContain(response.status);
      }
    });

    it("refuses an admin the courier's routes", async () => {
      const response = await call(code, 'get', '/payouts/courier/me/summary', admin.headers);
      expect([401, 403]).toContain(response.status);
    });

    it('lets ledger.view read lines, and keeps adjusting and settling to the protected keys', async () => {
      // The dispatcher role holds no payouts key (the operator holds ledger.view from seed v5).
      expect((await call(code, 'get', '/payouts/admin/lines', dispatcher.headers)).status).toBe(
        403,
      );
      const lines = await call(code, 'get', '/payouts/admin/lines', viewer.headers);
      expect(lines.status).toBe(200);
      expect(lines.body).toEqual(expect.objectContaining({ lines: expect.any(Array) as unknown }));

      const adjusted = await call(
        code,
        'post',
        `/payouts/admin/couriers/${courier.accountId}/adjustments`,
        viewer.headers,
        adjustment(currencyOf(code)),
      );
      const settled = await call(
        code,
        'post',
        `/payouts/admin/lines/${randomUUID()}/settle`,
        viewer.headers,
        {},
      );
      expect(adjusted.status).toBe(403);
      expect(settled.status).toBe(403);
    });

    it('refuses an unsafe admin request without its CSRF token', async () => {
      const { ['x-csrf-token']: _csrf, ...withoutToken } = admin.headers as Record<string, string>;
      void _csrf;

      const response = await call(
        code,
        'post',
        `/payouts/admin/couriers/${courier.accountId}/adjustments`,
        withoutToken,
        adjustment(currencyOf(code)),
      );

      expect([401, 403]).toContain(response.status);
    });
  });
});
