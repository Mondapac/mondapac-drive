import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  Temporal,
  type Clock,
  type IdGenerator,
  type MarketContext,
} from '@mondapac-drive/shared-kernel';
import type {
  RecipientDirectory,
  SmsSender,
  TrackingLinks,
  WebhookResponse,
  WebhookTransport,
} from '../../src/modules/notifications/application/ports';
import {
  DisableWebhookSubscription,
  RotateWebhookSecret,
} from '../../src/modules/notifications/application/use-cases/change-webhook-subscription.use-case';
import { DispatchSms } from '../../src/modules/notifications/application/use-cases/dispatch-sms.use-case';
import { DispatchWebhooks } from '../../src/modules/notifications/application/use-cases/dispatch-webhooks.use-case';
import { RecordDeliveryChange } from '../../src/modules/notifications/application/use-cases/record-delivery-change.use-case';
import { ResendWebhookCall } from '../../src/modules/notifications/application/use-cases/resend-webhook-call.use-case';
import { SubscribeToWebhooks } from '../../src/modules/notifications/application/use-cases/subscribe-to-webhooks.use-case';
import type { DeliveryChange } from '../../src/modules/notifications/domain/delivery-change';
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
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { notificationSettings } from '../support/notifications-markets';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The notifications module on PostgreSQL, for both Market fixtures: a delivery change queues one
// signed call per interested subscription and one SMS, once; the dispatch job sends, retries with
// the Market's back-off, dead-letters after the Market's attempts, and an operator re-sends; no
// phone number or text is stored; nothing crosses Markets.

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

const phones = new Map<string, string>();
const links = new Map<string, string>();
const recipients: RecipientDirectory = {
  phoneOf: (_m, id) =>
    phones.get(id) === 'throw'
      ? Promise.reject(new Error('directory unavailable'))
      : Promise.resolve(phones.get(id)),
};
const tracking: TrackingLinks = { linkFor: (_m, id) => Promise.resolve(links.get(id)) };

describe('notifications (database integration)', () => {
  let db: Persistence;
  let sql: Client;
  const clock = new TestClock(Temporal.Instant.from('2026-11-02T00:00:00Z'));
  const ids: IdGenerator = new UuidV7IdGenerator(clock);
  const signer = new HmacWebhookSigner(new Uint8Array(32).fill(3));
  const transport = new ScriptedTransport();
  const sms = new RecordingSmsSender();
  let subscriptions: PrismaWebhookSubscriptionRepository;
  let outbound: PrismaOutboundRepository;
  let subscribe: SubscribeToWebhooks;
  let rotate: RotateWebhookSecret;
  let disable: DisableWebhookSubscription;
  let record: RecordDeliveryChange;
  let dispatch: DispatchWebhooks;
  let dispatchSms: DispatchSms;
  let resend: ResendWebhookCall;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    subscriptions = new PrismaWebhookSubscriptionRepository(db.service);
    outbound = new PrismaOutboundRepository(db.service);
    subscribe = new SubscribeToWebhooks(subscriptions, signer, db.unitOfWork, ids, clock);
    rotate = new RotateWebhookSecret(subscriptions, signer, db.unitOfWork);
    disable = new DisableWebhookSubscription(subscriptions, db.unitOfWork);
    record = new RecordDeliveryChange(subscriptions, outbound, db.unitOfWork, ids, clock);
    dispatch = new DispatchWebhooks(
      outbound,
      subscriptions,
      signer,
      transport,
      notificationSettings,
      db.unitOfWork,
      clock,
    );
    dispatchSms = new DispatchSms(
      outbound,
      recipients,
      tracking,
      sms,
      notificationSettings,
      db.unitOfWork,
      clock,
    );
    resend = new ResendWebhookCall(outbound, db.unitOfWork, clock);
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  const change = (merchantId: string, overrides: Partial<DeliveryChange> = {}): DeliveryChange => ({
    eventId: randomUUID(),
    type: 'delivery.status-changed',
    occurredAt: clock.now(),
    deliveryId: randomUUID(),
    merchantId,
    externalReference: 'ORD-1',
    status: 'ASSIGNED',
    previousStatus: 'DISPATCHING',
    ...overrides,
  });

  /** Runs the webhook job until a pass claims nothing. */
  async function drain(market: MarketContext) {
    while ((await dispatch.run(market)).claimed > 0);
  }

  const read = (market: MarketContext, id: string) =>
    db.unitOfWork.run(
      market,
      async () => ({ ok: true as const, value: await outbound.findCall(market, id) }),
      {
        readOnly: true,
      },
    );

  async function callsOf(market: MarketContext, subscriptionId: string) {
    const due = await db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: (await outbound.dueCalls(market, clock.now().add({ hours: 24 * 365 }), 1000)).filter(
          (call) => call.subscriptionId === subscriptionId,
        ),
      }),
      { readOnly: true },
    );
    return due.ok ? due.value : [];
  }

  async function subscribed(
    market: MarketContext,
    merchantId: string,
    url: string,
    types?: string[],
  ) {
    const result = await subscribe.run(market, {
      merchantId,
      url,
      eventTypes: types ?? ['delivery.booked', 'delivery.status-changed'],
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const policy = notificationSettings.get(market.marketId).webhookRetry;

    it('subscribes with a secret shown once, and refuses unsafe URLs and unknown types', async () => {
      const merchant = `m-${randomUUID()}`;
      const { subscription, secret } = await subscribed(
        market,
        merchant,
        'https://hooks.example.com/a',
      );
      expect(secret).toBe(signer.secretFor(subscription.id, 1));

      for (const [url, codeOf] of [
        ['http://hooks.example.com/', 'webhook-url.not-https'],
        ['https://169.254.169.254/', 'webhook-url.private-host'],
      ]) {
        const refused = await subscribe.run(market, {
          merchantId: merchant,
          url: url!,
          eventTypes: ['delivery.booked'],
        });
        expect(refused).toMatchObject({ ok: false, error: { code: codeOf } });
      }
      const unknown = await subscribe.run(market, {
        merchantId: merchant,
        url: 'https://hooks.example.com/',
        eventTypes: ['delivery.picked'],
      });
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: 'webhook-subscription.unknown-event-type' },
      });
    });

    it('queues one signed call per interested subscription, once per event', async () => {
      const merchant = `m-${randomUUID()}`;
      const wanted = await subscribed(market, merchant, `https://a.example.com/${code}`);
      await subscribed(market, merchant, `https://b.example.com/${code}`, ['delivery.cancelled']);
      const first = change(merchant);

      expect(await record.run(market, first)).toEqual({
        ok: true,
        value: { webhookCalls: 1, sms: false },
      });
      expect(await record.run(market, first)).toEqual({
        ok: true,
        value: { webhookCalls: 0, sms: false },
      });

      transport.posted.length = 0;
      await drain(market);
      const posted = transport.posted.filter((entry) => entry.url === wanted.subscription.url);
      expect(posted).toHaveLength(1);
      const [call] = posted;
      expect(JSON.parse(call!.body)).toMatchObject({
        id: first.eventId,
        type: 'delivery.status-changed',
        marketId: code,
        data: { deliveryId: first.deliveryId, status: 'ASSIGNED' },
      });
      expect(call!.headers['Drive-Event-Id']).toBe(first.eventId);
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

    it("retries with the Market's back-off, dead-letters, and an operator re-sends", async () => {
      const merchant = `m-${randomUUID()}`;
      const { subscription } = await subscribed(
        market,
        merchant,
        `https://down.example.com/${code}`,
      );
      transport.answers.set(subscription.url, {
        ok: false,
        errorCode: 'http.503',
        statusCode: 503,
        retryable: true,
      });
      await record.run(market, change(merchant));
      const [queued] = await callsOf(market, subscription.id);
      const start = clock.instant;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        await drain(market);
        const stored = await read(market, queued!.id);
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

      transport.answers.delete(subscription.url);
      expect(await resend.run(market, queued!.id)).toMatchObject({
        ok: true,
        value: { status: 'pending', attempts: 0 },
      });
      await drain(market);
      const sent = await read(market, queued!.id);
      expect(sent.ok && sent.value).toMatchObject({
        status: 'sent',
        attempts: 1,
        lastStatusCode: 200,
      });
      expect(await resend.run(market, queued!.id)).toMatchObject({
        ok: false,
        error: { code: 'notifications.not-dead' },
      });
      clock.instant = start.add({ hours: 1 });
    });

    it('dies at once for a disabled subscription, and signs with the rotated secret', async () => {
      const merchant = `m-${randomUUID()}`;
      const kept = await subscribed(market, merchant, `https://kept.example.com/${code}`);
      const dropped = await subscribed(market, merchant, `https://dropped.example.com/${code}`);
      const rotated = await rotate.run(market, merchant, kept.subscription.id);
      expect(rotated.ok && rotated.value.subscription.secretVersion).toBe(2);
      await record.run(market, change(merchant));
      expect(await disable.run(market, merchant, dropped.subscription.id)).toMatchObject({
        ok: true,
        value: { status: 'disabled' },
      });

      transport.posted.length = 0;
      await drain(market);
      const { rows: dead } = await sql.query(
        'SELECT status, attempts, last_error_code FROM notifications.webhook_calls WHERE subscription_id = $1',
        [dropped.subscription.id],
      );
      expect(dead).toEqual([
        { status: 'dead', attempts: 1, last_error_code: 'webhook-subscription.disabled' },
      ]);
      expect(transport.posted.some((entry) => entry.url === dropped.subscription.url)).toBe(false);
      const post = transport.posted.find((entry) => entry.url === kept.subscription.url)!;
      const verify = (secret: string) =>
        verifyWebhookSignature({
          secret,
          timestampHeader: post.headers['Drive-Timestamp']!,
          signatureHeader: post.headers['Drive-Signature']!,
          rawBody: post.body,
          now: clock.now(),
        });
      expect(rotated.ok && verify(rotated.value.secret)).toBe(true);
      expect(verify(kept.secret)).toBe(false);
    });

    it("never lets a merchant change another merchant's subscription", async () => {
      const owner = await subscribed(
        market,
        `m-${randomUUID()}`,
        `https://own.example.com/${code}`,
      );
      expect(await disable.run(market, `m-${randomUUID()}`, owner.subscription.id)).toMatchObject({
        ok: false,
        error: { code: 'webhook-subscription.not-found' },
      });
    });

    it('sends the recipient SMS once, with the number read at send time and never stored', async () => {
      const merchant = `m-${randomUUID()}`;
      const booked = change(merchant, { type: 'delivery.booked', status: 'DISPATCHING' });
      const callingCode = notificationSettings.get(market.marketId).sms.allowedCallingCodes[0];
      phones.set(booked.deliveryId, `+${callingCode} 400 111 222`);

      expect(await record.run(market, booked)).toMatchObject({ ok: true, value: { sms: true } });
      expect(await record.run(market, { ...booked, eventId: randomUUID() })).toMatchObject({
        ok: true,
        value: { sms: false },
      });

      // The booked template needs the tracking link: no SMS until tracking issued one.
      sms.sent.length = 0;
      await dispatchSms.run(market);
      expect(sms.sent).toHaveLength(0);
      links.set(booked.deliveryId, 'https://track.example.com/t/x');
      clock.instant = clock.instant.add({ hours: 1 });
      while ((await dispatchSms.run(market)).claimed > 0);
      const mine = sms.sent.filter((entry) => entry.text.includes('https://track.example.com/t/x'));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        to: `+${callingCode}400111222`,
        from: notificationSettings.get(market.marketId).sms.senderId,
      });

      const { rows: stored } = await sql.query<{ row: string }>(
        'SELECT row_to_json(m)::text AS row FROM notifications.sms_messages m WHERE delivery_id = $1',
        [booked.deliveryId],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.row).not.toMatch(/400\s?111\s?222/);
      expect(stored[0]!.row).toContain('"status":"sent"');
    });

    it('refuses a number outside the Market (SMS pumping), and survives a lookup that throws', async () => {
      const abroad = change(`m-${randomUUID()}`, { status: 'DELIVERED' });
      phones.set(abroad.deliveryId, '+882 345 678 9012');
      const broken = change(`m-${randomUUID()}`, { status: 'DELIVERED' });
      phones.set(broken.deliveryId, 'throw');
      const fine = change(`m-${randomUUID()}`, { status: 'DELIVERED' });
      const callingCode = notificationSettings.get(market.marketId).sms.allowedCallingCodes[0];
      phones.set(fine.deliveryId, `+${callingCode} 400 999 000`);
      for (const each of [abroad, broken, fine]) await record.run(market, each);

      sms.sent.length = 0;
      await dispatchSms.run(market);
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
      const attempts = notificationSettings.get(market.marketId).sms.maxAttempts;
      for (let pass = 0; pass < attempts + 2; pass += 1) {
        clock.instant = clock.instant.add({ hours: 1 });
        await dispatchSms.run(market);
      }
      expect(await status(broken.deliveryId)).toMatchObject({ status: 'dead', attempts });
      expect(await status(fine.deliveryId)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(sms.sent.filter((entry) => entry.to.includes('400999000'))).toHaveLength(1);
    });

    it('dead-letters an SMS whose delivery has no usable number', async () => {
      const booked = change(`m-${randomUUID()}`, { status: 'DELIVERED' });
      await record.run(market, booked);
      while ((await dispatchSms.run(market)).claimed > 0);
      const { rows: stored } = await sql.query(
        'SELECT status, last_error_code FROM notifications.sms_messages WHERE delivery_id = $1',
        [booked.deliveryId],
      );
      expect(stored).toEqual([{ status: 'dead', last_error_code: 'sms.recipient-invalid' }]);
    });

    it("never shows a Market's calls or subscriptions to another Market", async () => {
      const merchant = `m-${randomUUID()}`;
      const { subscription } = await subscribed(
        market,
        merchant,
        `https://iso.example.com/${code}`,
      );
      await record.run(market, change(merchant));
      const other = marketOf(otherMarketOf(code));

      const found = await db.unitOfWork.run(
        other,
        async () => ({
          ok: true as const,
          value: await subscriptions.findById(other, subscription.id),
        }),
        { readOnly: true },
      );
      expect(found).toEqual({ ok: true, value: undefined });
      expect(await callsOf(other, subscription.id)).toEqual([]);
      await drain(market);
    });
  });
});
