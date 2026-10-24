import { createHmac, randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  err,
  money,
  ok,
  Temporal,
  uuidV7,
  type CallContext,
  type Id,
  type Money,
} from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import {
  DELIVERY_FACTS,
  PAYEE_DIRECTORY,
  PAYOUT_GATEWAY,
  PROVIDER_WEBHOOK_VERIFIER,
  type DeliveryFacts,
  type GatewayRefusal,
  type PayoutGateway,
  type ProviderTransfer,
} from '../../src/modules/payouts/application/ports';
import {
  GetCourierBalance,
  GetEarningsSummary,
  ViewCourierBalance,
} from '../../src/modules/payouts/application/use-cases/get-courier-balance.use-case';
import {
  HandleProviderWebhook,
  RETRY_LATER,
} from '../../src/modules/payouts/application/use-cases/handle-provider-webhook.use-case';
import { ListPayoutLines } from '../../src/modules/payouts/application/use-cases/list-payout-lines.use-case';
import { RecordAdjustment } from '../../src/modules/payouts/application/use-cases/record-adjustment.use-case';
import {
  RecordDeliveryEarning,
  type DeliveredInput,
} from '../../src/modules/payouts/application/use-cases/record-delivery-earning.use-case';
import { RecordTip } from '../../src/modules/payouts/application/use-cases/record-tip.use-case';
import { ReverseDeliveryEarning } from '../../src/modules/payouts/application/use-cases/reverse-delivery-earning.use-case';
import { RunPayouts } from '../../src/modules/payouts/application/use-cases/run-payouts.use-case';
import {
  SETTLE_NOT_FOUND_AFTER,
  SettleUnresolvedLine,
} from '../../src/modules/payouts/application/use-cases/settle-unresolved-line.use-case';
import { StartPayoutOnboarding } from '../../src/modules/payouts/application/use-cases/start-payout-onboarding.use-case';
import { EARNINGS_VIEW, ACCOUNT_ONBOARD } from '../../src/modules/payouts/contracts/permissions';
import type { Payee } from '../../src/modules/payouts/domain/payee';
import { MAX_TRANSFER_ATTEMPTS } from '../../src/modules/payouts/domain/payout-run';
import { latestCutoff } from '../../src/modules/payouts/domain/payout-schedule';
import { InMemoryPayeeDirectory } from '../../src/modules/payouts/infrastructure/in-memory-payee-directory';
import { StripeWebhookVerifier } from '../../src/modules/payouts/infrastructure/stripe-webhook-verifier';
import { DELIVERY_EARNING_SUBSCRIBER } from '../../src/modules/payouts/presentation/subscribers/delivery-earning.subscriptions';
import { AUTHORISATION_CHECK, type AuthorisationCheck } from '../../src/platform/authz';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { ProviderSecret } from '../../src/platform/config/payment-provider';
import { SubscriptionRegistry } from '../../src/platform/events/event-subscriptions';
import { issueDelivery } from '../../src/platform/persistence/outbox/delivery-ledger';
import { payoutMarkets } from '../support/payouts-markets';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Courier pay end to end on the booted application and PostgreSQL, for both Market fixtures,
// through the use cases behind the gate: delivered deliveries become ledger earnings once, the
// payout run of a closed period pays contractor balances through a fake provider with one
// idempotency key per line, refusals credit the balance back, an operator settles an unresolved
// line against the provider's transfers (audited), and the provider's signed webhooks update
// accounts and lines once (a reversal of a transfer not yet on its line is sent again later).
// The database is shared with the other spec files, so every test uses its own couriers and its
// own payout period, and looks only at its own couriers' lines.

const WEBHOOK_SECRET = 'whsec_flow_test_0123456789';

/** The courier keys; every other payouts key is a platform key, held by admins only here. */
const COURIER_KEYS = new Set<string>([EARNINGS_VIEW.key, ACCOUNT_ONBOARD.key]);

/** Identity's check, faked: a courier holds the courier keys, an admin every platform key. */
const authorisation: AuthorisationCheck = {
  check(context, declaration) {
    const { rule } = declaration;
    if (rule.kind !== 'permissions' || context.actor.kind !== 'authenticated') {
      return Promise.resolve({ allowed: true });
    }
    const courier = context.actor.population === 'courier';
    const allowed = rule.allOf.every((key) => COURIER_KEYS.has(key) === courier);
    return Promise.resolve(
      allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
    );
  },
};

interface SentTransfer {
  destination: string;
  amount: Money;
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

/** A provider that answers each transfer from a script, by destination, and records every call. */
class FakeGateway implements PayoutGateway {
  enabled = true;
  readonly transfers: SentTransfer[] = [];
  readonly accounts: { idempotencyKey: string; country: string }[] = [];
  readonly refusals = new Map<string, GatewayRefusal[]>();
  /** Transfers the provider made although Drive never heard back (for settling). */
  readonly unseen: (ProviderTransfer & { readonly group: string })[] = [];
  #accountIds = new Map<string, string>();
  #transferIds = new Map<string, string>();

  createAccount(request: { country: string; idempotencyKey: string }) {
    this.accounts.push(request);
    let id = this.#accountIds.get(request.idempotencyKey);
    if (id === undefined) {
      id = `acct_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      this.#accountIds.set(request.idempotencyKey, id);
    }
    return Promise.resolve(ok({ accountId: id }));
  }

  createOnboardingLink(request: { accountId: string }) {
    return Promise.resolve(
      ok({
        url: `https://connect.stripe.com/setup/e/${request.accountId}/x`,
        expiresAt: Temporal.Instant.from('2030-01-01T00:00:00Z'),
      }),
    );
  }

  createTransfer(request: SentTransfer) {
    this.transfers.push(request);
    const refusal = this.refusals.get(request.destination)?.shift();
    if (refusal !== undefined) return Promise.resolve(err(refusal));
    // The same key answers the same transfer, as Stripe's idempotency does.
    let id = this.#transferIds.get(request.idempotencyKey);
    if (id === undefined) {
      id = `tr_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      this.#transferIds.set(request.idempotencyKey, id);
    }
    return Promise.resolve(ok({ transferId: id }));
  }

  transfersOfGroup(group: string) {
    const sent = this.transfers
      .filter((transfer) => transfer.metadata.runId === group)
      .flatMap((transfer) => {
        const transferId = this.#transferIds.get(transfer.idempotencyKey);
        return transferId === undefined
          ? []
          : [
              {
                transferId,
                amount: transfer.amount,
                destination: transfer.destination,
                payoutLineId: transfer.metadata.payoutLineId!,
              },
            ];
      });
    const unseen = this.unseen.filter((transfer) => transfer.group === group);
    return Promise.resolve(
      ok([...new Map([...sent, ...unseen].map((t) => [t.transferId, t])).values()]),
    );
  }
}

const newId = <K extends string>() =>
  uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))) as Id<K>;

describe('courier pay and payouts (database integration)', () => {
  const clock = new FixedClock(Temporal.Instant.from('2031-01-01T00:00:00Z'));
  const payees = new InMemoryPayeeDirectory();
  const facts = new Map<string, DeliveryFacts>();
  const gateway = new FakeGateway();
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
      .overrideProvider(AUTHORISATION_CHECK)
      .useValue(authorisation)
      .overrideProvider(PAYEE_DIRECTORY)
      .useValue(payees)
      .overrideProvider(DELIVERY_FACTS)
      .useValue({ factsOf: (_: CallContext, id: string) => Promise.resolve(facts.get(id)) })
      .overrideProvider(PAYOUT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(PROVIDER_WEBHOOK_VERIFIER)
      .useValue(new StripeWebhookVerifier([new ProviderSecret(WEBHOOK_SECRET)]))
      .compile();
    app = await moduleRef.init();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  afterEach(() => {
    gateway.enabled = true;
  });

  /** One test's world: the clock in its own payout period, its couriers and its callers. */
  function world(code: string, periodIndex: number) {
    const market = marketOf(code);
    const settings = payoutMarkets.get(market.marketId);
    // Each test lives in its own period, weeks apart, so its run is its own.
    clock.set(
      Temporal.Instant.from('2031-01-01T00:00:00Z').add({ hours: 24 * 7 * 3 * periodIndex }),
    );
    const system = () => testCallContext(market, 'system', `payouts-job-${newId()}`);
    const person = (population: 'courier' | 'admin', accountId: string = newId()) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: accountId as Id<'Account'>,
          sessionId: newId(),
          merchantId: null,
        }),
        `payouts-${population}-${newId()}`,
      );
    const anonymous = () => testCallContext(market, 'anonymous', `payouts-hook-${newId()}`);
    const courier = (overrides: Partial<Payee> = {}): string => {
      const courierId = newId();
      payees.add(market.marketId, {
        courierId,
        engagement: 'contractor',
        taxRegistered: true,
        businessIdVerified: true,
        ...overrides,
      });
      return courierId;
    };
    const before = () =>
      latestCutoff(settings.schedule, settings.timezone, clock.now()).subtract({ hours: 1 });
    /** A delivery of `courierId` an hour before the latest cutoff, so the closed period has it. */
    const delivered = (courierId: string, deliveredAt = before()): DeliveredInput => {
      const deliveryId = newId();
      facts.set(deliveryId, { vehicle: 'van', distanceMetres: 10_000, temperature: 'frozen' });
      return { deliveryId, courierId, deliveredAt };
    };
    const m = (amount: bigint) => money(amount, settings.currency);
    const signed = (body: string) => {
      const t = clock.now().epochMilliseconds / 1000;
      const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
      return { rawBody: Buffer.from(body), signatureHeader: `t=${t},v1=${v1}` };
    };
    const hook = (type: string, object: object, created?: number) =>
      signed(
        JSON.stringify({
          id: `evt_${randomUUID().replaceAll('-', '')}`,
          type,
          ...(created === undefined ? {} : { created }),
          data: { object },
        }),
      );
    const earn = (input: DeliveredInput) => use(RecordDeliveryEarning).execute(system(), input);
    const pay = () => use(RunPayouts).execute(system(), {});
    const webhook = (input: ReturnType<typeof signed>) =>
      use(HandleProviderWebhook).execute(anonymous(), input);
    const balanceOf = async (courierId: string) => {
      const statement = await use(GetCourierBalance).execute(person('courier', courierId), {});
      if (!statement.ok) throw new Error(statement.error.code);
      return statement.value.balance.total;
    };
    const linesOf = async (courierId: string) => {
      const { rows } = await sql.query<{
        id: string;
        run_id: string;
        status: string;
        hold_reason: string | null;
        transfer_id: string | null;
        attempts: number;
      }>(
        `SELECT id, run_id, status, hold_reason, transfer_id, attempts FROM payouts.payout_lines
          WHERE market_id = $1 AND courier_id = $2 ORDER BY id`,
        [code, courierId],
      );
      return rows;
    };
    const eventsOf = async (lineId: string) => {
      const { rows } = await sql.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM payouts.outbox
          WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [code, lineId],
      );
      return rows;
    };
    const auditOf = async (targetId: string) => {
      const { rows } = await sql.query<{ action: string; actor_id: string; after: unknown }>(
        `SELECT action, actor_id, after FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [code, targetId],
      );
      return rows;
    };
    /** Onboards a courier and has the provider report the account ready to be paid. */
    const readyAccount = async (courierId: string): Promise<string> => {
      const link = await use(StartPayoutOnboarding).execute(person('courier', courierId), {});
      if (!link.ok) throw new Error(link.error.code);
      const accountId = /setup\/e\/([^/]+)\//.exec(link.value.url)![1]!;
      const created = clock.now().epochMilliseconds / 1000;
      expect(
        await webhook(hook('account.updated', { id: accountId, payouts_enabled: true }, created)),
      ).toEqual(ok({ outcome: 'applied' }));
      return accountId;
    };
    return {
      market,
      settings,
      courier,
      delivered,
      before,
      m,
      hook,
      earn,
      pay,
      webhook,
      person,
      system,
      balanceOf,
      linesOf,
      eventsOf,
      auditOf,
      readyAccount,
    };
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const index = TEST_MARKETS.indexOf(code) * 25;

    it('records an earning once per delivery, with tax for a registered contractor', async () => {
      const w = world(code, index + 1);
      const registered = w.courier();
      const unregistered = w.courier({ taxRegistered: false });
      const employee = w.courier({ engagement: 'employee' });
      const fact = w.delivered(registered);

      const first = await w.earn(fact);
      const again = await w.earn(fact);
      await w.earn(w.delivered(unregistered));
      const staff = await w.earn(w.delivered(employee));

      // van: base + 10 km + frozen bonus, before tax.
      const rate = w.settings.earnings.vehicles.van!;
      const pay = BigInt(
        rate.perDelivery + rate.perKm * 10 + w.settings.earnings.coldChainBonus.frozen,
      );
      const tax = (pay * BigInt(w.settings.tax.rateBps) + 5000n) / 10_000n;
      expect(first.ok && first.value.entry).toEqual(
        expect.objectContaining({ kind: 'earning', amount: w.m(pay), tax: w.m(tax) }),
      );
      expect(again).toEqual(ok(expect.objectContaining({ recorded: false })));
      expect(await w.balanceOf(registered)).toEqual(w.m(pay + tax));
      expect(await w.balanceOf(unregistered)).toEqual(w.m(pay));
      expect(staff.ok && staff.value).toEqual(
        expect.objectContaining({
          recorded: true,
          earning: expect.objectContaining({ total: w.m(0n) }) as unknown,
        }),
      );
      expect(staff.ok && staff.value.entry).toBeUndefined();
      expect(await w.balanceOf(employee)).toEqual(w.m(0n));
    });

    it("sums the courier's earnings today and this week, and today's deliveries", async () => {
      const w = world(code, index + 2);
      const courierId = w.courier({ taxRegistered: false });
      const now = Temporal.Instant.from('2031-01-01T00:00:00Z').add({
        hours: 24 * 7 * 3 * (index + 2),
      });
      const zone = w.settings.timezone;
      const startOfDay = now.toZonedDateTimeISO(zone).startOfDay();
      const monday = startOfDay.subtract({ days: startOfDay.dayOfWeek - 1 }).toInstant();
      await w.earn(w.delivered(courierId, now));
      // Earlier this week (when today is not Monday), and last week.
      if (Temporal.Instant.compare(monday, startOfDay.toInstant()) < 0) {
        await w.earn(w.delivered(courierId, monday.add({ minutes: 1 })));
      }
      await w.earn(w.delivered(courierId, monday.subtract({ hours: 1 })));
      const rate = w.settings.earnings.vehicles.van!;
      const each = BigInt(
        rate.perDelivery + rate.perKm * 10 + w.settings.earnings.coldChainBonus.frozen,
      );
      const thisWeek = Temporal.Instant.compare(monday, startOfDay.toInstant()) < 0 ? 2n : 1n;

      const summary = await use(GetEarningsSummary).execute(w.person('courier', courierId), {});

      expect(summary).toEqual(
        ok({ today: w.m(each), week: w.m(each * thisWeek), deliveriesToday: 1 }),
      );
    });

    it('refuses a courier fleet does not know and a delivery delivery does not know', async () => {
      const w = world(code, index + 3);
      const known = w.courier();

      expect(await w.earn(w.delivered(newId()))).toEqual(
        err(expect.objectContaining({ code: 'payouts.unknown-courier' })),
      );
      expect(
        await w.earn({ deliveryId: newId(), courierId: known, deliveredAt: w.before() }),
      ).toEqual(err(expect.objectContaining({ code: 'payouts.unknown-delivery' })));
    });

    it("records an earning from delivery's delivered event once, and ignores every other status", async () => {
      const w = world(code, index + 19);
      const courierId = w.courier({ taxRegistered: false });
      const fact = w.delivered(courierId);
      const subscriber = app.get(SubscriptionRegistry).get(DELIVERY_EARNING_SUBSCRIBER)!;
      const statusChanged = (status: string, courier: string | null) => ({
        eventId: newId(),
        type: 'delivery.status-changed.v1',
        occurredAt: fact.deliveredAt,
        market: w.market,
        aggregateType: 'delivery',
        aggregateId: fact.deliveryId as Id,
        aggregateVersion: 5,
        correlationId: w.system().correlationId,
        causationId: null,
        payload: {
          deliveryId: fact.deliveryId,
          status,
          previousStatus: 'at-dropoff',
          courierId: courier,
          reason: null,
        },
      });
      // A delivery handed out as the dispatcher hands one out: in-process, so another spec
      // file's dispatcher (whose fakes know none of these couriers) never claims it.
      const deliver = (event: ReturnType<typeof statusChanged>, attempt = 1) =>
        subscriber.handle(
          event,
          issueDelivery(
            { eventId: event.eventId as Id<'event'>, subscriber: subscriber.name, attempt },
            w.market,
            () => clock.now(),
          ),
          w.system() as Parameters<typeof subscriber.handle>[2],
        );
      const delivered = statusChanged('delivered', courierId);
      const rate = w.settings.earnings.vehicles.van!;
      const pay = BigInt(
        rate.perDelivery + rate.perKm * 10 + w.settings.earnings.coldChainBonus.frozen,
      );

      expect(subscriber.event.type).toBe('delivery.status-changed.v1');
      await deliver(statusChanged('at-dropoff', courierId));
      await deliver(statusChanged('delivered', null));
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));

      await deliver(delivered);
      // A redelivery of the same event, and another event for the same delivery, earn nothing.
      await deliver(delivered, 2);
      await deliver(statusChanged('delivered', courierId));
      expect(await w.balanceOf(courierId)).toEqual(w.m(pay));

      // A refusal throws, so the dispatcher retries the event.
      await expect(deliver(statusChanged('delivered', newId()))).rejects.toThrow(
        `${DELIVERY_EARNING_SUBSCRIBER} refused: payouts.unknown-courier`,
      );
    });

    it('pays a closed period once: one line per courier, one transfer per line, balance to zero', async () => {
      const w = world(code, index + 4);
      const paid = w.courier();
      const noAccount = w.courier();
      const account = await w.readyAccount(paid);
      await w.earn(w.delivered(paid));
      await use(RecordTip).execute(w.system(), {
        deliveryId: newId(),
        courierId: paid,
        amount: w.m(500n),
        occurredAt: w.before(),
      });
      await w.earn(w.delivered(noAccount));
      const owed = await w.balanceOf(paid);

      const tick = await w.pay();
      const second = await w.pay();

      expect(tick.ok && tick.value.opened).toBeDefined();
      expect(second.ok && second.value.opened).toBeUndefined();
      expect(gateway.transfers.filter((t) => t.destination === account)).toEqual([
        expect.objectContaining({
          amount: owed,
          idempotencyKey: expect.stringMatching(/^payout-line-/) as unknown,
        }),
      ]);
      const [line] = await w.linesOf(paid);
      expect(line).toEqual(
        expect.objectContaining({
          status: 'transferred',
          transfer_id: expect.stringMatching(/^tr_/) as unknown,
        }),
      );
      expect(await w.eventsOf(line!.id)).toEqual([
        {
          type: 'payouts.line-transferred.v1',
          payload: { lineId: line!.id, runId: line!.run_id, courierId: paid },
        },
      ]);
      expect(await w.linesOf(noAccount)).toEqual([
        expect.objectContaining({ status: 'held', hold_reason: 'no-payout-account' }),
      ]);
      expect(await w.balanceOf(paid)).toEqual(w.m(0n));
      expect((await w.balanceOf(noAccount)).amount).toBeGreaterThan(0n);
    });

    it('credits back a transfer refused for good, and pays it in the next period', async () => {
      const w = world(code, index + 5);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      const owed = await w.balanceOf(courierId);
      gateway.refusals.set(account, [{ code: 'stripe.account_invalid', transient: false }]);

      const tick = await w.pay();

      expect(tick.ok && tick.value.failed).toBeGreaterThanOrEqual(1);
      const [failed] = await w.linesOf(courierId);
      expect(failed).toEqual(expect.objectContaining({ status: 'failed' }));
      expect(await w.eventsOf(failed!.id)).toEqual([
        expect.objectContaining({
          type: 'payouts.line-failed.v1',
          payload: expect.objectContaining({ status: 'failed' }) as unknown,
        }),
      ]);
      expect(await w.balanceOf(courierId)).toEqual(owed);

      clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.pay();
      expect((await w.linesOf(courierId)).map((line) => line.status)).toEqual([
        'failed',
        'transferred',
      ]);
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));
    });

    it('retries a transient refusal on the next tick with the same idempotency key', async () => {
      const w = world(code, index + 6);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      gateway.refusals.set(account, [{ code: 'stripe.unreachable', transient: true }]);

      await w.pay();
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'pending', attempts: 1 }),
      ]);
      await w.pay();

      const keys = gateway.transfers
        .filter((t) => t.destination === account)
        .map((t) => t.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'transferred', attempts: 2 }),
      ]);
    });

    it('holds a pending line whose account was disabled since the run opened (L5)', async () => {
      const w = world(code, index + 7);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      const owed = await w.balanceOf(courierId);
      gateway.enabled = false;
      await w.pay(); // opens the run and debits the line; nothing is sent without a provider
      gateway.enabled = true;
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));
      const created = Temporal.Instant.from('2040-01-01T00:00:00Z').epochMilliseconds / 1000;
      await w.webhook(w.hook('account.updated', { id: account, payouts_enabled: false }, created));

      const tick = await w.pay();

      expect(tick.ok && tick.value.held).toBe(1);
      expect(gateway.transfers.filter((t) => t.destination === account)).toEqual([]);
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'held', hold_reason: 'payouts-disabled' }),
      ]);
      expect(await w.balanceOf(courierId)).toEqual(owed);
    });

    it('keeps the debit of a line out of transient attempts, and never pays it again', async () => {
      const w = world(code, index + 8);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      gateway.refusals.set(
        account,
        Array.from({ length: MAX_TRANSFER_ATTEMPTS }, () => ({
          code: 'stripe.unreachable',
          transient: true,
        })),
      );

      for (let tick = 0; tick < MAX_TRANSFER_ATTEMPTS; tick += 1) await w.pay();
      const [line] = await w.linesOf(courierId);
      expect(line).toEqual(
        expect.objectContaining({ status: 'unresolved', attempts: MAX_TRANSFER_ATTEMPTS }),
      );
      expect((await w.eventsOf(line!.id)).map((event) => event.payload.status)).toEqual([
        'unresolved',
      ]);
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));

      clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.pay();
      expect(await w.linesOf(courierId)).toHaveLength(1);
      expect(gateway.transfers.filter((t) => t.destination === account)).toHaveLength(
        MAX_TRANSFER_ATTEMPTS,
      );
    });

    it("settles unresolved lines against the provider's transfers, audited", async () => {
      const w = world(code, index + 9);
      const made = w.courier();
      const never = w.courier();
      const accounts = [await w.readyAccount(made), await w.readyAccount(never)];
      await w.earn(w.delivered(made));
      await w.earn(w.delivered(never));
      const owed = await w.balanceOf(never);
      for (const account of accounts) {
        gateway.refusals.set(
          account,
          Array.from({ length: MAX_TRANSFER_ATTEMPTS }, () => ({
            code: 'stripe.unreachable',
            transient: true,
          })),
        );
      }
      for (let tick = 0; tick < MAX_TRANSFER_ATTEMPTS; tick += 1) await w.pay();
      const [madeLine] = await w.linesOf(made);
      const [neverLine] = await w.linesOf(never);
      const sent = gateway.transfers.find((t) => t.destination === accounts[0])!;
      // The provider made the first courier's transfer, but every answer was lost.
      gateway.unseen.push({
        group: madeLine!.run_id,
        transferId: 'tr_unseen0123456789',
        amount: sent.amount,
        destination: accounts[0]!,
        payoutLineId: madeLine!.id,
      });
      const admin = w.person('admin');
      const settle = (lineId: string, context = admin) =>
        use(SettleUnresolvedLine).execute(context, { lineId: lineId as Id<'PayoutLine'> });

      expect(await settle(madeLine!.id, w.person('courier', made))).toEqual(
        err(expect.objectContaining({ code: 'access.denied' })),
      );
      const transferred = await settle(madeLine!.id);
      // "Not transferred" waits until the provider has had time to list the last attempt (L-b).
      const early = await settle(neverLine!.id);
      clock.advance(SETTLE_NOT_FOUND_AFTER);
      const failed = await settle(neverLine!.id);
      const again = await settle(neverLine!.id);

      expect(transferred).toEqual(
        ok(
          expect.objectContaining({
            providerTransferFound: true,
            line: expect.objectContaining({
              status: 'transferred',
              transferId: 'tr_unseen0123456789',
            }) as unknown,
          }),
        ),
      );
      expect(early).toEqual(err(expect.objectContaining({ code: 'payouts.settle-too-early' })));
      expect(failed).toEqual(ok(expect.objectContaining({ providerTransferFound: false })));
      expect(again).toEqual(err(expect.objectContaining({ code: 'payouts.line-state' })));
      expect(await w.balanceOf(made)).toEqual(w.m(0n));
      expect(await w.balanceOf(never)).toEqual(owed);
      expect((await w.eventsOf(madeLine!.id)).map((event) => event.type)).toEqual([
        'payouts.line-failed.v1',
        'payouts.line-transferred.v1',
      ]);
      expect(await w.auditOf(neverLine!.id)).toEqual([
        {
          action: 'payouts.line.settled',
          actor_id: admin.actor.kind === 'authenticated' ? admin.actor.accountId : '',
          after: { status: 'failed', courierId: never, providerTransferFound: false },
        },
      ]);

      clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.pay();
      expect((await w.linesOf(never)).map((line) => line.status)).toEqual([
        'failed',
        'transferred',
      ]);
    });

    it('refuses to settle a line the provider holds a different transfer for', async () => {
      const w = world(code, index + 10);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      gateway.refusals.set(
        account,
        Array.from({ length: MAX_TRANSFER_ATTEMPTS }, () => ({
          code: 'stripe.unreachable',
          transient: true,
        })),
      );
      for (let tick = 0; tick < MAX_TRANSFER_ATTEMPTS; tick += 1) await w.pay();
      const [line] = await w.linesOf(courierId);
      gateway.unseen.push({
        group: line!.run_id,
        transferId: 'tr_different0123456',
        amount: w.m(1n),
        destination: account,
        payoutLineId: line!.id,
      });

      expect(
        await use(SettleUnresolvedLine).execute(w.person('admin'), {
          lineId: line!.id as Id<'PayoutLine'>,
        }),
      ).toEqual(err(expect.objectContaining({ code: 'payouts.settle-mismatch' })));
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'unresolved' }),
      ]);
    });

    it('refuses to settle as not transferred while a transfer without its line id could be it (L-b)', async () => {
      const w = world(code, index + 20);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      gateway.refusals.set(
        account,
        Array.from({ length: MAX_TRANSFER_ATTEMPTS }, () => ({
          code: 'stripe.unreachable',
          transient: true,
        })),
      );
      for (let tick = 0; tick < MAX_TRANSFER_ATTEMPTS; tick += 1) await w.pay();
      const [line] = await w.linesOf(courierId);
      const sent = gateway.transfers.find((t) => t.destination === account)!;
      // The provider holds the transfer, but its metadata did not survive.
      gateway.unseen.push({
        group: line!.run_id,
        transferId: 'tr_nometadata012345',
        amount: sent.amount,
        destination: account,
      });
      clock.advance(SETTLE_NOT_FOUND_AFTER);

      expect(
        await use(SettleUnresolvedLine).execute(w.person('admin'), {
          lineId: line!.id as Id<'PayoutLine'>,
        }),
      ).toEqual(err(expect.objectContaining({ code: 'payouts.settle-ambiguous' })));
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'unresolved' }),
      ]);
    });

    it('marks a reversed transfer once, and credits no balance with it (an operator clawback)', async () => {
      const w = world(code, index + 11);
      const courierId = w.courier();
      await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      await w.pay();
      const [line] = await w.linesOf(courierId);
      const reversal = w.hook('transfer.reversed', {
        id: line!.transfer_id,
        amount_reversed: 300,
        currency: w.settings.currency.toLowerCase(),
        metadata: { marketId: code, payoutLineId: line!.id, runId: line!.run_id },
      });

      expect(await w.webhook(reversal)).toEqual(
        ok({ outcome: 'applied', transferId: line!.transfer_id, lineId: line!.id }),
      );
      expect(await w.webhook(reversal)).toEqual(ok({ outcome: 'duplicate' }));
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));
      expect(await w.linesOf(courierId)).toEqual([expect.objectContaining({ status: 'reversed' })]);
      clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.pay();
      expect(await w.linesOf(courierId)).toHaveLength(1);
    });

    it('asks again later for a reversal of its own transfer not yet on a line (M2)', async () => {
      const w = world(code, index + 12);
      const unknownLine = newId();
      const reversal = (metadata: object) =>
        w.hook('transfer.reversed', {
          id: `tr_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          amount_reversed: 100,
          currency: w.settings.currency.toLowerCase(),
          metadata,
        });
      const ours = reversal({ marketId: code, payoutLineId: unknownLine });

      const first = await w.webhook(ours);
      const redelivered = await w.webhook(ours);

      for (const answer of [first, redelivered]) {
        expect(answer).toEqual(
          err(expect.objectContaining({ code: RETRY_LATER, alert: 'reversal-unmatched' })),
        );
      }
      // Another Market's transfer is not this endpoint's to retry; a foreign one is flagged.
      expect(await w.webhook(reversal({ marketId: code === 'AU' ? 'ZZ' : 'AU' }))).toEqual(
        ok({ outcome: 'ignored' }),
      );
      expect(await w.webhook(reversal({}))).toEqual(
        ok(expect.objectContaining({ outcome: 'ignored', alert: 'reversal-foreign' })),
      );
    });

    it('alerts on a reversal in another currency than its line, and changes nothing', async () => {
      const w = world(code, index + 13);
      const courierId = w.courier();
      await w.readyAccount(courierId);
      await w.earn(w.delivered(courierId));
      await w.pay();
      const [line] = await w.linesOf(courierId);

      expect(
        await w.webhook(
          w.hook('transfer.reversed', {
            id: line!.transfer_id,
            amount_reversed: 100,
            currency: w.settings.currency === 'EUR' ? 'usd' : 'eur',
            metadata: { marketId: code, payoutLineId: line!.id },
          }),
        ),
      ).toEqual(ok(expect.objectContaining({ alert: 'reversal-currency-mismatch' })));
      expect(await w.linesOf(courierId)).toEqual([
        expect.objectContaining({ status: 'transferred' }),
      ]);
    });

    it('ignores an account update older than the state stored (L1)', async () => {
      const w = world(code, index + 14);
      const courierId = w.courier();
      const account = await w.readyAccount(courierId);
      const earlier = clock.now().epochMilliseconds / 1000 - 60;

      expect(
        await w.webhook(
          w.hook('account.updated', { id: account, payouts_enabled: false }, earlier),
        ),
      ).toEqual(ok({ outcome: 'ignored' }));
      const { rows } = await sql.query<{ payouts_enabled: boolean }>(
        'SELECT payouts_enabled FROM payouts.payout_accounts WHERE market_id = $1 AND courier_id = $2',
        [code, courierId],
      );
      expect(rows).toEqual([{ payouts_enabled: true }]);
    });

    it('refuses a webhook that was not signed with the endpoint secret', async () => {
      const w = world(code, index + 15);
      const body = JSON.stringify({
        id: 'evt_forged',
        type: 'account.updated',
        data: { object: {} },
      });
      const forged = `t=${clock.now().epochMilliseconds / 1000},v1=${'a'.repeat(64)}`;

      expect(await w.webhook({ rawBody: Buffer.from(body), signatureHeader: forged })).toEqual(
        err(expect.objectContaining({ code: 'payouts.webhook-signature-invalid' })),
      );
    });

    it('creates one provider account per courier, and none for an employee', async () => {
      const w = world(code, index + 16);
      const courierId = w.courier();
      const employee = w.courier({ engagement: 'employee' });
      const onboard = (id: string) =>
        use(StartPayoutOnboarding).execute(w.person('courier', id), {});
      const before = gateway.accounts.length;

      const first = await onboard(courierId);
      const second = await onboard(courierId);

      expect(first.ok && second.ok).toBe(true);
      expect(gateway.accounts.slice(before)).toEqual([
        {
          country: w.settings.provider.accountCountry,
          idempotencyKey: `payout-account-${code}-${w.market.tenantId}-${courierId}`,
          metadata: expect.anything() as unknown,
        },
      ]);
      expect(await onboard(employee)).toEqual(
        err(expect.objectContaining({ code: 'payouts.not-a-contractor' })),
      );
      expect(await use(StartPayoutOnboarding).execute(w.person('admin'), {})).toEqual(
        err(expect.objectContaining({ code: 'access.denied' })),
      );
      gateway.enabled = false;
      expect(await onboard(courierId)).toEqual(
        err(expect.objectContaining({ code: 'payouts.provider-unavailable' })),
      );
    });

    it('reverses what a delivery credited, once, and records an audited adjustment once', async () => {
      const w = world(code, index + 17);
      const courierId = w.courier();
      const fact = w.delivered(courierId);
      await w.earn(fact);
      await use(RecordTip).execute(w.system(), {
        deliveryId: fact.deliveryId,
        courierId,
        amount: w.m(200n),
        occurredAt: fact.deliveredAt,
      });

      const reverse = () =>
        use(ReverseDeliveryEarning).execute(w.system(), { deliveryId: fact.deliveryId });
      const reversed = await reverse();
      const again = await reverse();
      expect(reversed.ok && reversed.value.reversals).toHaveLength(2);
      expect(again.ok && again.value.reversals).toHaveLength(0);
      expect(await w.balanceOf(courierId)).toEqual(w.m(0n));

      const admin = w.person('admin');
      const key = `ops-${randomUUID()}`;
      const bonus = { courierId, amount: w.m(1000n), reason: 'bonus' as const, key };
      const adjust = (input: typeof bonus) => use(RecordAdjustment).execute(admin, input);
      expect(await adjust(bonus)).toEqual(ok(expect.objectContaining({ recorded: true })));
      expect(await adjust(bonus)).toEqual(ok(expect.objectContaining({ recorded: false })));
      expect(await adjust({ ...bonus, amount: w.m(5n) })).toEqual(
        err(expect.objectContaining({ code: 'payouts.key-reused' })),
      );
      expect(await use(RecordAdjustment).execute(w.person('courier', courierId), bonus)).toEqual(
        err(expect.objectContaining({ code: 'access.denied' })),
      );
      const tax = (1000n * BigInt(w.settings.tax.rateBps)) / 10_000n;
      expect(await w.balanceOf(courierId)).toEqual(w.m(1000n + tax));
      expect(await w.auditOf(courierId)).toEqual([
        expect.objectContaining({
          action: 'payouts.adjustment.recorded',
          after: expect.objectContaining({ reason: 'bonus' }) as unknown,
        }),
      ]);
    });

    it('lists held lines for operators a page at a time, and to no courier', async () => {
      const w = world(code, index + 18);
      const held = [w.courier(), w.courier(), w.courier()];
      for (const courierId of held) await w.earn(w.delivered(courierId));
      await w.pay();
      const list = (after?: Id<'PayoutLine'>) =>
        use(ListPayoutLines).execute(w.person('admin'), {
          statuses: ['held'],
          limit: 2,
          ...(after === undefined ? {} : { after }),
        });
      const mine = new Set(held);
      const ours: string[] = [];
      let page = await list();
      for (let guard = 0; page.ok && guard < 1000; guard += 1) {
        ours.push(...page.value.lines.filter((l) => mine.has(l.courierId)).map((l) => l.courierId));
        if (page.value.next === undefined) break;
        page = await list(page.value.next);
      }

      expect(ours.sort()).toEqual([...held].sort());
      expect(
        await use(ListPayoutLines).execute(w.person('courier', held[0]), { statuses: ['held'] }),
      ).toEqual(err(expect.objectContaining({ code: 'access.denied' })));
      const statement = await use(ViewCourierBalance).execute(w.person('admin'), {
        courierId: held[0]!,
      });
      expect(statement.ok && statement.value.entries).toHaveLength(1);
    });
  });

  it('keeps each Market to its own ledger', async () => {
    const au = world('AU', 50);
    const zz = world('ZZ', 50);
    const courierId = au.courier();
    payees.add(zz.market.marketId, {
      courierId,
      engagement: 'contractor',
      taxRegistered: false,
      businessIdVerified: true,
    });
    await au.earn(au.delivered(courierId));

    const statement = await use(GetCourierBalance).execute(zz.person('courier', courierId), {});
    expect(statement.ok && statement.value.entries).toEqual([]);
  });
});
