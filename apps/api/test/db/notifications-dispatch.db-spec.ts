import { Client } from 'pg';
import {
  ok,
  Temporal,
  type CallContext,
  type Clock,
  type Id,
  type IdGenerator,
  type MarketContext,
} from '@mondapac-drive/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac-drive/shared-kernel/testing';
import type {
  DeliveryContact,
  DeliveryContacts,
  SmsSender,
  TrackingLinks,
  WebhookResponse,
  WebhookTransport,
} from '../../src/modules/notifications/application/ports';
import {
  ChangeWebhookEventTypes,
  DisableWebhookSubscription,
  ListWebhookSubscriptions,
  RotateWebhookSecret,
} from '../../src/modules/notifications/application/use-cases/change-webhook-subscription.use-case';
import { DispatchSms } from '../../src/modules/notifications/application/use-cases/dispatch-sms.use-case';
import { DispatchWebhooks } from '../../src/modules/notifications/application/use-cases/dispatch-webhooks.use-case';
import {
  RecordDeliveryChange,
  type DeliveryEventInput,
} from '../../src/modules/notifications/application/use-cases/record-delivery-change.use-case';
import {
  ListDeadWebhookCalls,
  ResendWebhookCall,
} from '../../src/modules/notifications/application/use-cases/resend-webhook-call.use-case';
import { SubscribeToWebhooks } from '../../src/modules/notifications/application/use-cases/subscribe-to-webhooks.use-case';
import { NOTIFICATIONS_AUDIT_ACTIONS } from '../../src/modules/notifications/domain/audit';
import { retryDelaySeconds } from '../../src/modules/notifications/domain/outbound-message';
import type { WebhookUrl } from '../../src/modules/notifications/domain/webhook-url';
import {
  HmacWebhookSigner,
  verifyWebhookSignature,
} from '../../src/modules/notifications/infrastructure/hmac-webhook-signer';
import {
  PrismaOutboundRepository,
  PrismaWebhookSubscriptionRepository,
} from '../../src/modules/notifications/infrastructure/prisma-notifications.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { createAuditWriter } from '../../src/platform/persistence/audit/prisma-audit-writer';
import { MODEL_MAP } from '../../src/generated/model-map';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { fakeRunOnce } from '../support/fake-run-once';
import { notificationSettings } from '../support/notifications-markets';
import { openGate } from '../support/system-only-denial';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The notifications module on PostgreSQL, for both Market fixtures, through its use cases behind
// the gate: a merchant (its API key) subscribes, changes and rotates; a delivery event queues one
// signed call per interested subscription and one SMS, once; the dispatch jobs (system) send,
// retry with the Market's back-off, dead-letter after the Market's attempts, sign with both
// secrets during a rotation's overlap, and an operator re-sends; every change is audited; no
// phone number, PIN or text is stored; nothing crosses Markets. The inbox of `runOnce` is the
// platform's (test/db/event-delivery.db-spec.ts); here an in-memory one stands in for it.

class TestClock implements Clock {
  constructor(public instant: Temporal.Instant) {}
  now(): Temporal.Instant {
    return this.instant;
  }
}

interface Posted {
  readonly url: WebhookUrl;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers per URL; anything not scripted answers 200. */
class ScriptedTransport implements WebhookTransport {
  readonly posted: Posted[] = [];
  readonly answers = new Map<string, WebhookResponse>();
  post(url: WebhookUrl, headers: Readonly<Record<string, string>>, body: string) {
    this.posted.push({ url, headers, body });
    return Promise.resolve(this.answers.get(url) ?? { ok: true as const, statusCode: 200 });
  }
}

class RecordingSmsSender implements SmsSender {
  readonly sent: { to: string; from: string; text: string }[] = [];
  send(to: string, from: string, text: string) {
    this.sent.push({ to, from, text });
    return Promise.resolve({ ok: true as const, providerMessageId: `SM${'0'.repeat(32)}` });
  }
}

/** The delivery module's read, scripted per delivery; `'throw'` as the phone makes it fail. */
const contacts = new Map<string, DeliveryContact>();
const deliveryContacts: DeliveryContacts = {
  referenceOf: (_context, id) => {
    const found = contacts.get(id);
    return Promise.resolve(
      found && { merchantId: found.merchantId, externalReference: found.externalReference },
    );
  },
  contactOf: (_context, id) =>
    contacts.get(id)?.dropoffPhone === 'throw'
      ? Promise.reject(new Error('delivery unavailable'))
      : Promise.resolve(contacts.get(id)),
};
/** Tracking's link tokens, scripted per delivery; none until a test sets one. */
const tokens = new Map<string, string>();
const tracking: TrackingLinks = { issue: (_context, id) => Promise.resolve(tokens.get(id)) };

let serial = 0;
const idsOutsideTheClock = new UuidV7IdGenerator({
  now: () => Temporal.Instant.from('2026-11-01T00:00:00Z'),
});
/** A fresh UUIDv7, as the platform's ids and the actor checks expect. */
const uuid = (): Id => idsOutsideTheClock.next();
const fakeDelivery = (eventId: string, subscriber: string): EventDelivery => ({
  eventId: eventId as Id<'event'>,
  subscriber,
  attempt: 1,
});

describe('notifications (database integration)', () => {
  let db: Persistence;
  let sql: Client;
  const clock = new TestClock(Temporal.Instant.from('2026-11-02T00:00:00Z'));
  const ids: IdGenerator = new UuidV7IdGenerator(clock);
  const signer = new HmacWebhookSigner(new Uint8Array(32).fill(3));
  const transport = new ScriptedTransport();
  const sms = new RecordingSmsSender();
  const gate = openGate();
  let subscriptions: PrismaWebhookSubscriptionRepository;
  let outbound: PrismaOutboundRepository;
  let subscribe: SubscribeToWebhooks;
  let list: ListWebhookSubscriptions;
  let changeTypes: ChangeWebhookEventTypes;
  let rotate: RotateWebhookSecret;
  let disable: DisableWebhookSubscription;
  let record: RecordDeliveryChange;
  let dispatch: DispatchWebhooks;
  let dispatchSms: DispatchSms;
  let resend: ResendWebhookCall;
  let deadCalls: ListDeadWebhookCalls;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    subscriptions = new PrismaWebhookSubscriptionRepository(db.service);
    outbound = new PrismaOutboundRepository(db.service);
    const catalogue = new AuditActionCatalogue();
    catalogue.register('notifications', NOTIFICATIONS_AUDIT_ACTIONS);
    catalogue.seal();
    const audit = createAuditWriter('notifications', {
      catalogue,
      ids,
      clock,
      permissionKeys: NO_PERMISSION_KEYS,
    });
    const unitOfWork = db.unitOfWork;
    const settings = notificationSettings;
    const change = { subscriptions, signer, settings, audit, unitOfWork, clock };
    subscribe = new SubscribeToWebhooks(gate, {
      subscriptions,
      signer,
      audit,
      unitOfWork,
      ids,
      clock,
    });
    list = new ListWebhookSubscriptions(gate, { subscriptions, unitOfWork });
    changeTypes = new ChangeWebhookEventTypes(gate, change);
    rotate = new RotateWebhookSecret(gate, change);
    disable = new DisableWebhookSubscription(gate, change);
    // The real inbox needs a delivery the dispatcher handed out; an in-memory one stands in.
    const onceUnit: UnitOfWork = { run: unitOfWork.run.bind(unitOfWork), runOnce: fakeRunOnce() };
    const onceRunning: UnitOfWork = {
      run: unitOfWork.run.bind(unitOfWork),
      runOnce: (market, delivery, work) =>
        onceUnit.runOnce(market, delivery, () => unitOfWork.run(market, work)),
    };
    record = new RecordDeliveryChange(gate, {
      contacts: deliveryContacts,
      subscriptions,
      outbound,
      unitOfWork: onceRunning,
      ids,
      clock,
    });
    dispatch = new DispatchWebhooks(gate, {
      outbound,
      subscriptions,
      signer,
      transport,
      settings,
      unitOfWork,
      clock,
    });
    dispatchSms = new DispatchSms(gate, {
      outbound,
      contacts: deliveryContacts,
      tracking,
      sender: sms,
      settings,
      unitOfWork,
      clock,
    });
    resend = new ResendWebhookCall(gate, { outbound, audit, unitOfWork, clock });
    deadCalls = new ListDeadWebhookCalls(gate, { outbound, unitOfWork });
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  it('gives notifications an inbox for runOnce', () => {
    expect(MODEL_MAP.modules.notifications?.inboxModel).toBe('NotificationsInbox');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const policy = notificationSettings.get(market.marketId).webhookRetry;
    const smsSettings = notificationSettings.get(market.marketId).sms;
    const callingCode = smsSettings.allowedCallingCodes[0];
    const system = () => testCallContext(market, 'system', `notif-sys-${++serial}`);
    const merchantContext = (merchantId: Id): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'merchant',
          accountId: uuid() as never,
          sessionId: uuid() as never,
          merchantId: merchantId as never,
        }),
        `notif-merchant-${++serial}`,
      );
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: uuid() as never,
          sessionId: uuid() as never,
          merchantId: null,
        }),
        `notif-admin-${++serial}`,
      );

    /** A delivery the delivery module knows, with its merchant, reference and contact. */
    function deliveryOf(merchantId: Id, contact: Partial<DeliveryContact> = {}): string {
      const deliveryId = uuid();
      contacts.set(deliveryId, {
        merchantId,
        externalReference: 'ORD-1',
        dropoffPhone: `+${callingCode} 400 111 222`,
        recipientPin: null,
        ...contact,
      });
      return deliveryId;
    }

    const event = (
      deliveryId: string,
      overrides: Partial<Omit<DeliveryEventInput, 'delivery'>> = {},
    ): DeliveryEventInput => {
      const eventId = overrides.eventId ?? uuid();
      return {
        eventId,
        type: 'delivery.status-changed',
        occurredAt: clock.now(),
        deliveryId,
        status: 'ASSIGNED',
        previousStatus: 'DISPATCHING',
        ...overrides,
        delivery: fakeDelivery(eventId, 'notifications.delivery-status-changed'),
      };
    };

    /** Runs the webhook job until a pass claims nothing. */
    async function drain() {
      for (;;) {
        const pass = await dispatch.execute(system(), {});
        if (!pass.ok || pass.value.claimed === 0) return;
      }
    }
    async function drainSms() {
      for (;;) {
        const pass = await dispatchSms.execute(system(), {});
        if (!pass.ok || pass.value.claimed === 0) return;
      }
    }

    const read = (id: string) =>
      db.unitOfWork.run(market, async () => ok(await outbound.findCall(market, id)), {
        readOnly: true,
      });

    async function callsOf(at: MarketContext, subscriptionId: string) {
      const due = await db.unitOfWork.run(
        at,
        async () =>
          ok(
            (await outbound.dueCalls(at, clock.now().add({ hours: 24 * 365 }), 1000)).filter(
              (call) => call.subscriptionId === subscriptionId,
            ),
          ),
        { readOnly: true },
      );
      return due.ok ? due.value : [];
    }

    async function subscribed(merchantId: Id, url: string, types?: string[]) {
      const result = await subscribe.execute(merchantContext(merchantId), {
        url,
        eventTypes: types ?? ['delivery.booked', 'delivery.status-changed'],
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    }

    async function auditOf(targetId: string) {
      const { rows } = await sql.query<{ action: string; actor_type: string }>(
        'SELECT action, actor_type FROM platform.audit_log WHERE target_id = $1 ORDER BY action',
        [targetId],
      );
      return rows;
    }

    it('subscribes with a secret shown once, audited, and refuses unsafe URLs and unknown types', async () => {
      const merchant = uuid();
      const { subscription, secret } = await subscribed(merchant, 'https://hooks.example.com/a');
      expect(secret).toBe(signer.secretFor(subscription.id, 1));
      expect(subscription.merchantId).toBe(merchant);
      expect(await auditOf(subscription.id)).toEqual([
        { action: 'notifications.webhook-subscription.created', actor_type: 'USER' },
      ]);

      for (const [url, codeOf] of [
        ['http://hooks.example.com/', 'webhook-url.not-https'],
        ['https://169.254.169.254/', 'webhook-url.private-host'],
      ]) {
        const refused = await subscribe.execute(merchantContext(merchant), {
          url: url!,
          eventTypes: ['delivery.booked'],
        });
        expect(refused).toMatchObject({ ok: false, error: { code: codeOf } });
      }
      const unknown = await subscribe.execute(merchantContext(merchant), {
        url: 'https://hooks.example.com/',
        eventTypes: ['delivery.picked'],
      });
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: 'webhook-subscription.unknown-event-type' },
      });
      expect(
        await subscribe.execute(admin(), {
          url: 'https://a.example.com/',
          eventTypes: ['delivery.booked'],
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it("lists the merchant's own subscriptions and changes their event types, audited", async () => {
      const merchant = uuid();
      const first = await subscribed(merchant, `https://list-a.example.com/${code}`);
      clock.instant = clock.instant.add({ seconds: 1 });
      const second = await subscribed(merchant, `https://list-b.example.com/${code}`);
      await subscribed(uuid(), `https://other.example.com/${code}`);

      const listed = await list.execute(merchantContext(merchant), {});
      expect(listed.ok && listed.value.map((entry) => entry.id)).toEqual([
        second.subscription.id,
        first.subscription.id,
      ]);

      const changed = await changeTypes.execute(merchantContext(merchant), {
        subscriptionId: first.subscription.id,
        eventTypes: ['delivery.cancelled', 'delivery.booked'],
      });
      expect(changed).toMatchObject({
        ok: true,
        value: { eventTypes: ['delivery.booked', 'delivery.cancelled'], version: 2 },
      });
      // The same types again change nothing and write no audit row.
      await changeTypes.execute(merchantContext(merchant), {
        subscriptionId: first.subscription.id,
        eventTypes: ['delivery.booked', 'delivery.cancelled'],
      });
      expect((await auditOf(first.subscription.id)).map((row) => row.action)).toEqual([
        'notifications.webhook-subscription.created',
        'notifications.webhook-subscription.event-types-changed',
      ]);
    });

    it('queues one signed call per interested subscription, once per event, with the reference from delivery', async () => {
      const merchant = uuid();
      const wanted = await subscribed(merchant, `https://a.example.com/${code}`);
      await subscribed(merchant, `https://b.example.com/${code}`, ['delivery.cancelled']);
      const first = event(deliveryOf(merchant, { externalReference: 'ORD-77' }));

      expect(await record.execute(system(), first)).toEqual({
        ok: true,
        value: { handled: true, webhookCalls: 1, sms: false },
      });
      expect(await record.execute(system(), first)).toEqual({
        ok: true,
        value: { handled: false },
      });

      transport.posted.length = 0;
      await drain();
      const posted = transport.posted.filter((entry) => entry.url === wanted.subscription.url);
      expect(posted).toHaveLength(1);
      const [call] = posted;
      expect(JSON.parse(call!.body)).toEqual({
        id: first.eventId,
        type: 'delivery.status-changed',
        occurredAt: first.occurredAt.toString(),
        marketId: code,
        data: {
          deliveryId: first.deliveryId,
          externalReference: 'ORD-77',
          status: 'ASSIGNED',
          previousStatus: 'DISPATCHING',
        },
      });
      expect(call!.headers['Drive-Event-Id']).toBe(first.eventId);
      expect(call!.headers['Drive-Signature']!.split(',')).toHaveLength(1);
      expect(
        verifyWebhookSignature({
          secret: wanted.secret,
          timestampHeader: call!.headers['Drive-Timestamp']!,
          signatureHeader: call!.headers['Drive-Signature']!,
          rawBody: call!.body,
          now: clock.now(),
        }),
      ).toBe(true);
    });

    it('refuses an event of a delivery the delivery module does not know, so it is retried', async () => {
      expect(await record.execute(system(), event(uuid()))).toMatchObject({
        ok: false,
        error: { code: 'notifications.delivery-unknown' },
      });
    });

    it("retries with the Market's back-off, dead-letters, and an operator lists and re-sends, audited", async () => {
      const merchant = uuid();
      const { subscription } = await subscribed(merchant, `https://down.example.com/${code}`);
      transport.answers.set(subscription.url, {
        ok: false,
        errorCode: 'http.503',
        statusCode: 503,
        retryable: true,
      });
      await record.execute(system(), event(deliveryOf(merchant)));
      const [queued] = await callsOf(market, subscription.id);
      const start = clock.instant;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        await drain();
        const stored = await read(queued!.id);
        expect(stored.ok && stored.value).toMatchObject({ attempts: attempt, lastStatusCode: 503 });
        if (attempt < policy.maxAttempts) {
          expect(stored.ok && stored.value?.status).toBe('pending');
          expect(stored.ok && stored.value?.nextAttemptAt).toEqual(
            clock.instant.add({ seconds: retryDelaySeconds(policy, attempt) }),
          );
          clock.instant = clock.instant.add({ seconds: retryDelaySeconds(policy, attempt) });
        } else {
          expect(stored.ok && stored.value).toMatchObject({
            status: 'dead',
            lastErrorCode: 'http.503',
          });
        }
      }

      const dead = await deadCalls.execute(admin(), {});
      expect(dead.ok && dead.value.some((call) => call.id === queued!.id)).toBe(true);
      // Each dead call names its subscription's merchant, for the operator's support.
      expect(dead.ok && dead.value.find((call) => call.id === queued!.id)?.merchantId).toBe(
        subscription.merchantId,
      );
      expect(await resend.execute(merchantContext(merchant), { callId: queued!.id })).toMatchObject(
        {
          ok: false,
          error: { code: 'access.denied' },
        },
      );

      transport.answers.delete(subscription.url);
      expect(await resend.execute(admin(), { callId: queued!.id })).toMatchObject({
        ok: true,
        value: { status: 'pending', attempts: 0 },
      });
      expect(await auditOf(queued!.id)).toEqual([
        { action: 'notifications.webhook-call.resent', actor_type: 'USER' },
      ]);
      await drain();
      const sent = await read(queued!.id);
      expect(sent.ok && sent.value).toMatchObject({
        status: 'sent',
        attempts: 1,
        lastStatusCode: 200,
      });
      expect(await resend.execute(admin(), { callId: queued!.id })).toMatchObject({
        ok: false,
        error: { code: 'notifications.not-dead' },
      });
      clock.instant = start.add({ hours: 1 });
    });

    it('dies at once for a disabled subscription, and signs with both secrets during a rotation overlap', async () => {
      const merchant = uuid();
      const kept = await subscribed(merchant, `https://kept.example.com/${code}`);
      const dropped = await subscribed(merchant, `https://dropped.example.com/${code}`);
      const rotated = await rotate.execute(merchantContext(merchant), {
        subscriptionId: kept.subscription.id,
      });
      const overlap = notificationSettings.get(market.marketId).rotationOverlapSeconds;
      expect(rotated).toMatchObject({
        ok: true,
        value: {
          subscription: {
            secretVersion: 2,
            previousSecretValidUntil: clock.now().add({ seconds: overlap }),
          },
        },
      });
      await record.execute(system(), event(deliveryOf(merchant)));
      expect(
        await disable.execute(merchantContext(merchant), {
          subscriptionId: dropped.subscription.id,
        }),
      ).toMatchObject({ ok: true, value: { status: 'disabled' } });
      expect((await auditOf(kept.subscription.id)).map((row) => row.action)).toEqual([
        'notifications.webhook-subscription.created',
        'notifications.webhook-subscription.secret-rotated',
      ]);
      expect((await auditOf(dropped.subscription.id)).map((row) => row.action)).toEqual([
        'notifications.webhook-subscription.created',
        'notifications.webhook-subscription.disabled',
      ]);

      transport.posted.length = 0;
      await drain();
      const { rows: dead } = await sql.query(
        'SELECT status, attempts, last_error_code FROM notifications.webhook_calls WHERE subscription_id = $1',
        [dropped.subscription.id],
      );
      expect(dead).toEqual([
        { status: 'dead', attempts: 1, last_error_code: 'webhook-subscription.disabled' },
      ]);
      expect(transport.posted.some((entry) => entry.url === dropped.subscription.url)).toBe(false);
      const post = transport.posted.find((entry) => entry.url === kept.subscription.url)!;
      const verify = (secret: string, posted = post) =>
        verifyWebhookSignature({
          secret,
          timestampHeader: posted.headers['Drive-Timestamp']!,
          signatureHeader: posted.headers['Drive-Signature']!,
          rawBody: posted.body,
          now: clock.now(),
        });
      expect(post.headers['Drive-Signature']!.split(',')).toHaveLength(2);
      expect(rotated.ok && verify(rotated.value.secret)).toBe(true);
      expect(verify(kept.secret)).toBe(true);

      // After the overlap only the new secret signs.
      clock.instant = clock.instant.add({ seconds: overlap });
      await record.execute(system(), event(deliveryOf(merchant)));
      transport.posted.length = 0;
      await drain();
      const later = transport.posted.find((entry) => entry.url === kept.subscription.url)!;
      expect(later.headers['Drive-Signature']!.split(',')).toHaveLength(1);
      expect(rotated.ok && verify(rotated.value.secret, later)).toBe(true);
      expect(verify(kept.secret, later)).toBe(false);
    });

    it("never lets a merchant see or change another merchant's subscription", async () => {
      const owner = await subscribed(uuid(), `https://own.example.com/${code}`);
      const stranger = merchantContext(uuid());
      for (const refused of [
        await disable.execute(stranger, { subscriptionId: owner.subscription.id }),
        await rotate.execute(stranger, { subscriptionId: owner.subscription.id }),
        await changeTypes.execute(stranger, {
          subscriptionId: owner.subscription.id,
          eventTypes: ['delivery.booked'],
        }),
      ]) {
        expect(refused).toMatchObject({
          ok: false,
          error: { code: 'webhook-subscription.not-found' },
        });
      }
      const listed = await list.execute(stranger, {});
      expect(listed).toEqual({ ok: true, value: [] });
    });

    it('sends the booked SMS once, with the number, PIN and link read at send time and never stored', async () => {
      const merchant = uuid();
      const deliveryId = deliveryOf(merchant, { recipientPin: '4821' });
      const booked = event(deliveryId, { type: 'delivery.booked', status: 'DISPATCHING' });

      expect(await record.execute(system(), booked)).toMatchObject({
        ok: true,
        value: { sms: true },
      });
      expect(
        await record.execute(
          system(),
          event(deliveryId, { type: 'delivery.booked', status: 'DISPATCHING' }),
        ),
      ).toMatchObject({ ok: true, value: { sms: false } });

      // The booked template shows the tracking link: no SMS until tracking issues one.
      sms.sent.length = 0;
      await dispatchSms.execute(system(), {});
      expect(sms.sent).toHaveLength(0);
      tokens.set(deliveryId, `tok-${code}`);
      clock.instant = clock.instant.add({ hours: 1 });
      await drainSms();
      const url = smsSettings.trackingPageUrl.replace('{token}', `tok-${code}`);
      const mine = sms.sent.filter((entry) => entry.text.includes(url));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        to: `+${callingCode}400111222`,
        from: smsSettings.senderId,
      });
      expect(mine[0]!.text).toContain(smsSettings.pinText.replace('{pin}', '4821'));

      const { rows: stored } = await sql.query<{ row: string }>(
        'SELECT row_to_json(m)::text AS row FROM notifications.sms_messages m WHERE delivery_id = $1',
        [deliveryId],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.row).not.toMatch(/400\s?111\s?222|4821|tok-/);
      expect(stored[0]!.row).toContain('"status":"sent"');
    });

    it('never shows the PIN outside the booked SMS', async () => {
      const deliveryId = deliveryOf(uuid(), { recipientPin: '9137' });
      await record.execute(
        system(),
        event(deliveryId, { status: 'DELIVERED', previousStatus: 'AT_DROPOFF' }),
      );
      sms.sent.length = 0;
      await drainSms();
      const delivered = sms.sent.filter((entry) => entry.text.includes(smsSettings.optOutText));
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.some((entry) => entry.text.includes('9137'))).toBe(false);
    });

    it('refuses a number outside the Market (SMS pumping), and survives a lookup that throws', async () => {
      const abroad = event(deliveryOf(uuid()), { status: 'DELIVERED' });
      const broken = event(deliveryOf(uuid()), { status: 'DELIVERED' });
      const fine = event(deliveryOf(uuid(), { dropoffPhone: `+${callingCode} 400 999 000` }), {
        status: 'DELIVERED',
      });
      for (const each of [abroad, broken, fine]) await record.execute(system(), each);
      contacts.set(abroad.deliveryId, {
        ...contacts.get(abroad.deliveryId)!,
        dropoffPhone: '+882 345 678 9012',
      });
      contacts.set(broken.deliveryId, {
        ...contacts.get(broken.deliveryId)!,
        dropoffPhone: 'throw',
      });

      sms.sent.length = 0;
      await dispatchSms.execute(system(), {});
      const status = async (deliveryId: string) =>
        (
          await sql.query<{ status: string; attempts: number; last_error_code: string | null }>(
            'SELECT status, attempts, last_error_code FROM notifications.sms_messages WHERE delivery_id = $1',
            [deliveryId],
          )
        ).rows[0];
      expect(await status(abroad.deliveryId)).toMatchObject({
        status: 'dead',
        last_error_code: 'sms.recipient-region',
      });
      expect(await status(broken.deliveryId)).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error_code: 'notifications.internal',
      });
      expect(await status(fine.deliveryId)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(sms.sent.filter((entry) => entry.to.includes('400999000'))).toHaveLength(1);

      // The lookup keeps throwing: retried until the Market's attempts, then dead, never sent twice.
      const attempts = smsSettings.maxAttempts;
      for (let pass = 0; pass < attempts + 2; pass += 1) {
        clock.instant = clock.instant.add({ hours: 1 });
        await dispatchSms.execute(system(), {});
      }
      expect(await status(broken.deliveryId)).toMatchObject({ status: 'dead', attempts });
      expect(await status(fine.deliveryId)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(sms.sent.filter((entry) => entry.to.includes('400999000'))).toHaveLength(1);
    });

    it('dead-letters an SMS whose delivery has no usable number', async () => {
      const delivered = event(deliveryOf(uuid(), { dropoffPhone: null }), { status: 'DELIVERED' });
      await record.execute(system(), delivered);
      await drainSms();
      const { rows: stored } = await sql.query(
        'SELECT status, last_error_code FROM notifications.sms_messages WHERE delivery_id = $1',
        [delivered.deliveryId],
      );
      expect(stored).toEqual([{ status: 'dead', last_error_code: 'sms.recipient-invalid' }]);
    });

    it('runs the jobs and the event use case for the system actor only', async () => {
      const merchant = merchantContext(uuid());
      for (const refused of [
        await dispatch.execute(merchant, {}),
        await dispatchSms.execute(admin(), {}),
        await record.execute(merchant, event(deliveryOf(uuid()))),
      ]) {
        expect(refused).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
    });

    it("never shows a Market's calls or subscriptions to another Market", async () => {
      const merchant = uuid();
      const { subscription } = await subscribed(merchant, `https://iso.example.com/${code}`);
      await record.execute(system(), event(deliveryOf(merchant)));
      const other = marketOf(otherMarketOf(code));

      const found = await db.unitOfWork.run(
        other,
        async () => ok(await subscriptions.findById(other, subscription.id)),
        { readOnly: true },
      );
      expect(found).toEqual({ ok: true, value: undefined });
      expect(await callsOf(other, subscription.id)).toEqual([]);
      await drain();
    });
  });
});
