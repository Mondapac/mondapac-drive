import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import {
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  type DispatchJobRepository,
  type DispatchSettingsProvider,
} from '../../src/modules/dispatch/application/ports';
import { DispatchModule } from '../../src/modules/dispatch';
import { openDispatchJob, sendWave, sweep } from '../../src/modules/dispatch/domain/dispatch-job';
import {
  PUSH_SENDER,
  type PushSender,
  type PushTicket,
} from '../../src/modules/notifications/application/ports';
import type { ExpoPushToken, OfferPush } from '../../src/modules/notifications/domain/push-device';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { IDENTITY_FACADE, type IdentityFacade } from '../../src/modules/identity';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { requirements, stops } from '../support/dispatch-markets';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type CourierActor } from './actor-support';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Courier push on the real application and database, for both Market fixtures: a courier's
// bearer session registers its push device (the token sealed at rest, found by a keyed digest,
// never in clear), one per session, and drops it on sign-out; any other population is refused;
// an offer dispatch sends reaches the courier's device through the outbox, the event dispatcher
// and the notifications inbox, once, with the offer id only; a device Expo no longer knows is
// dropped. Expo itself is replaced by a recording sender.

const PATH = '/notifications/courier/me/push-device';

class RecordingPushSender implements PushSender {
  readonly sent: { to: readonly ExpoPushToken[]; push: OfferPush }[] = [];
  readonly answers = new Map<string, PushTicket>();
  send(to: readonly ExpoPushToken[], push: OfferPush) {
    this.sent.push({ to, push });
    return Promise.resolve(to.map((token) => this.answers.get(token) ?? { ok: true as const }));
  }
}

let serial = 0;
/** A fresh Expo token: 22 characters of base62, as Expo issues them. */
const expoToken = () =>
  `ExponentPushToken[${(Date.now().toString(36) + (++serial).toString(36)).padEnd(22, 'x')}]`;

describe('notifications push (database integration)', () => {
  let app: NestExpressApplication;
  let sql: Client;
  const sender = new RecordingPushSender();

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  const put = (code: string, headers: object, body: object) =>
    request(app.getHttpServer())
      .put(PATH)
      .set({ 'x-market-id': code, ...headers })
      .send(body);
  const del = (code: string, headers: object) =>
    request(app.getHttpServer())
      .delete(PATH)
      .set({ 'x-market-id': code, ...headers });

  async function handleAll(): Promise<void> {
    const relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    const dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    for (let pass = 0; pass < 5; pass += 1) {
      while ((await relay.runOnce()).published > 0);
      let claimed = 0;
      for (
        let batch = await dispatcher.runOnce();
        batch.claimed > 0;
        batch = await dispatcher.runOnce()
      ) {
        claimed += batch.claimed;
      }
      if (claimed === 0) return;
    }
  }

  /** Handles events until `settled` holds (other spec files share the outbox, see dispatch-api). */
  async function handleUntil(settled: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await handleAll();
      if (await settled()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    let actors: TestActors;
    let courier: CourierActor;

    beforeAll(async () => {
      ({ app } = await createTestApp({
        panelOrigins: true,
        env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
        override: (builder) => builder.overrideProvider(PUSH_SENDER).useValue(sender),
      }));
      actors = new TestActors(app, code);
      await actors.seedRoles();
      courier = await actors.courier();
    });

    afterAll(async () => {
      await app.close();
    });

    const rowsOf = async (accountId: string) =>
      (
        await sql.query<{
          session_id: string;
          platform: string;
          token_sealed: string;
          token_lookup: string;
        }>(
          `SELECT session_id, platform, token_sealed, token_lookup FROM notifications.push_devices
            WHERE market_id = $1 AND account_id = $2 ORDER BY registered_at`,
          [market.marketId, accountId],
        )
      ).rows;

    /** A job whose first wave offered the delivery to `couriers`, stored as dispatch stores it. */
    async function offeredTo(...couriers: CourierActor[]) {
      const ids = app.get<IdGenerator>(ID_GENERATOR, { strict: false });
      const clock = app.get<Clock>(CLOCK, { strict: false });
      const settings = app
        .get<DispatchSettingsProvider>(DISPATCH_SETTINGS, { strict: false })
        .get(market.marketId);
      const jobs = app.get<DispatchJobRepository>(DISPATCH_JOB_REPOSITORY, { strict: false });
      const now = clock.now();
      const opened = openDispatchJob(
        {
          id: ids.next<'DispatchJob'>(),
          marketId: market.marketId,
          deliveryId: ids.next<'Delivery'>(),
          requirements: requirements(),
          stops: stops(),
          deliveryVersion: 1,
        },
        now,
        settings,
      );
      const wave = sendWave(
        sweep(opened, now, settings).job,
        couriers.map((c, i) => ({
          courierId: c.accountId as string as never,
          vehicle: 'car' as const,
          distanceMetres: 100 * (i + 1),
        })),
        now,
        { ...settings, waveSize: couriers.length },
        () => ids.next<'DispatchOffer'>(),
      );
      const unit = app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
      const outbox = app.select(DispatchModule).get<OutboxWriter>(OUTBOX_WRITER, { strict: true });
      await unit.run(market, async () => {
        await jobs.insert(market, opened);
        await jobs.update(market, wave.job);
        await outbox.append(testCallContext(market, 'system', 'push-offer-0001'), wave.events);
        return { ok: true as const, value: undefined };
      });
      return wave.job;
    }

    it('registers one sealed device per session and drops it on sign-out', async () => {
      const first = expoToken();
      const second = expoToken();
      expect((await put(code, courier.headers, { token: first, platform: 'ios' })).status).toBe(
        204,
      );
      expect(
        (await put(code, courier.headers, { token: second, platform: 'android' })).status,
      ).toBe(204);
      const rows = await rowsOf(courier.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.platform).toBe('android');
      expect(rows[0]!.token_sealed).toMatch(/^v1\./);
      expect(JSON.stringify(rows)).not.toContain(second.slice(18, 40));
      expect(rows[0]!.token_lookup).toMatch(/^[0-9a-f]{64}$/);

      // The same phone under a new session of the same courier: the token moves.
      const again = await actors.courier();
      expect((await put(code, again.headers, { token: second, platform: 'android' })).status).toBe(
        204,
      );
      expect(await rowsOf(courier.accountId)).toEqual([]);
      expect(await rowsOf(again.accountId)).toHaveLength(1);

      expect((await del(code, again.headers)).status).toBe(204);
      expect((await del(code, again.headers)).status).toBe(204);
      expect(await rowsOf(again.accountId)).toEqual([]);
    });

    /** The session id of a courier's bearer session, as identity stores it. */
    const sessionOf = async (accountId: string) =>
      (
        await sql.query<{ id: string }>(
          `SELECT id FROM identity.sessions WHERE market_id = $1 AND account_id = $2`,
          [market.marketId, accountId],
        )
      ).rows.map((row) => row.id);
    const revoke = (accountId: string) =>
      sql.query(
        `UPDATE identity.sessions SET revoked_at = now(), revoked_reason = 'test.revoked'
          WHERE market_id = $1 AND account_id = $2`,
        [market.marketId, accountId],
      );

    it("moves a phone's token from one courier to another who signs in on it", async () => {
      const first = await actors.courier();
      const second = await actors.courier();
      const token = expoToken();
      await put(code, first.headers, { token, platform: 'ios' });
      await put(code, second.headers, { token, platform: 'ios' });
      expect(await rowsOf(first.accountId)).toEqual([]);
      expect(await rowsOf(second.accountId)).toHaveLength(1);
    });

    it("tells notifications which of a courier's sessions live (identity's system read)", async () => {
      const identity = app.get<IdentityFacade>(IDENTITY_FACADE, { strict: false });
      const system = testCallContext(market, 'system', 'push-sessions-0001');
      const alive = await actors.courier();
      const other = await actors.courier();
      const [aliveSession] = await sessionOf(alive.accountId);
      const [otherSession] = await sessionOf(other.accountId);
      const asked = [aliveSession!, otherSession!, '0195f000-0000-7000-8000-0000000000ff'];
      expect(await identity.liveSessionsOf(system, alive.accountId, asked)).toEqual({
        ok: true,
        value: new Set([aliveSession]),
      });
      await revoke(alive.accountId);
      expect(await identity.liveSessionsOf(system, alive.accountId, asked)).toEqual({
        ok: true,
        value: new Set(),
      });
      expect(
        (
          await identity.liveSessionsOf(
            testCallContext(market, 'anonymous', 'push-anon-0001'),
            alive.accountId,
            asked,
          )
        ).ok,
      ).toBe(false);
    });

    it('never pushes to the device of a session that ended without a sign-out, and drops it', async () => {
      const ended = await actors.courier();
      const token = expoToken();
      await put(code, ended.headers, { token, platform: 'ios' });
      await revoke(ended.accountId);
      await offeredTo(ended);
      await handleUntil(async () => (await rowsOf(ended.accountId)).length === 0);
      expect(await rowsOf(ended.accountId)).toEqual([]);
      expect(sender.sent.filter((sent) => sent.to.includes(token as never))).toEqual([]);
    });

    it('refuses a token that is not Expo, an unknown field, and any caller but a courier', async () => {
      const bad = await put(code, courier.headers, { token: 'fcm:abc', platform: 'ios' });
      expect(bad.status).toBe(400);
      expect((bad.body as { code: string }).code).toBe('push-device.invalid-token');
      expect(
        (await put(code, courier.headers, { token: expoToken(), platform: 'ios', courierId: 'x' }))
          .status,
      ).toBe(400);
      expect(
        (await put(code, courier.headers, { token: expoToken(), platform: 'web' })).status,
      ).toBe(400);
      const admin = await actors.admin(panelHeaders(code).origin);
      const merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      for (const headers of [admin.headers, merchant.headers, {}]) {
        const refused = await put(code, headers, { token: expoToken(), platform: 'ios' });
        expect([401, 403]).toContain(refused.status);
      }
    });

    it('pushes a sent offer to the courier once, with the offer id only, and drops a gone device', async () => {
      const pushed = await actors.courier();
      const gone = await actors.courier();
      const pushedToken = expoToken();
      const goneToken = expoToken();
      await put(code, pushed.headers, { token: pushedToken, platform: 'ios' });
      await put(code, gone.headers, { token: goneToken, platform: 'android' });
      sender.answers.set(goneToken, {
        ok: false,
        errorCode: 'push.DeviceNotRegistered',
        retryable: false,
        deviceGone: true,
      });

      const job = await offeredTo(pushed, gone);
      const to = (token: string) => sender.sent.filter((sent) => sent.to.includes(token as never));
      await handleUntil(
        async () => to(pushedToken).length > 0 && (await rowsOf(gone.accountId)).length === 0,
      );

      const [mine] = to(pushedToken);
      const offer = job.offers.find((o) => o.courierId === (pushed.accountId as string))!;
      expect(mine!.push.data).toEqual({ kind: 'offer', offerId: offer.id });
      expect(mine!.push.body).not.toMatch(/Pickup|Dropoff|Street|Road/);
      expect(mine!.push.ttlSeconds).toBeGreaterThan(0);
      expect(await rowsOf(gone.accountId)).toEqual([]);
      expect(await rowsOf(pushed.accountId)).toHaveLength(1);

      await handleAll();
      expect(to(pushedToken)).toHaveLength(1);
    });
  });
});
