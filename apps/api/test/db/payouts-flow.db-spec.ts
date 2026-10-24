import { createHmac, randomUUID } from 'node:crypto';
import {
  err,
  money,
  ok,
  Temporal,
  type MarketContext,
  type Money,
} from '@mondapac-drive/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac-drive/shared-kernel/testing';
import type { GatewayRefusal, PayoutGateway } from '../../src/modules/payouts/application/ports';
import { GetCourierBalance } from '../../src/modules/payouts/application/use-cases/get-courier-balance.use-case';
import { HandleProviderWebhook } from '../../src/modules/payouts/application/use-cases/handle-provider-webhook.use-case';
import { RecordAdjustment } from '../../src/modules/payouts/application/use-cases/record-adjustment.use-case';
import { RecordDeliveryEarning } from '../../src/modules/payouts/application/use-cases/record-delivery-earning.use-case';
import { RecordTip } from '../../src/modules/payouts/application/use-cases/record-tip.use-case';
import { ReverseDeliveryEarning } from '../../src/modules/payouts/application/use-cases/reverse-delivery-earning.use-case';
import { RunPayouts } from '../../src/modules/payouts/application/use-cases/run-payouts.use-case';
import { StartPayoutOnboarding } from '../../src/modules/payouts/application/use-cases/start-payout-onboarding.use-case';
import type { CompletedDelivery } from '../../src/modules/payouts/domain/earnings';
import type { Payee } from '../../src/modules/payouts/domain/payee';
import { latestCutoff } from '../../src/modules/payouts/domain/payout-schedule';
import { MAX_TRANSFER_ATTEMPTS } from '../../src/modules/payouts/domain/payout-run';
import { InMemoryPayeeDirectory } from '../../src/modules/payouts/infrastructure/in-memory-payee-directory';
import { PrismaLedgerRepository } from '../../src/modules/payouts/infrastructure/prisma-ledger.repository';
import { PrismaPayoutAccountRepository } from '../../src/modules/payouts/infrastructure/prisma-payout-accounts.repository';
import { PrismaPayoutRunRepository } from '../../src/modules/payouts/infrastructure/prisma-payout-runs.repository';
import { StripeWebhookVerifier } from '../../src/modules/payouts/infrastructure/stripe-webhook-verifier';
import { ProviderSecret } from '../../src/platform/config/payment-provider';
import { payoutMarkets } from '../support/payouts-markets';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// Courier pay end to end on PostgreSQL, for both Market fixtures: delivered deliveries become
// ledger earnings once, the payout run of a closed period pays contractor balances through a
// fake provider with one idempotency key per line, refusals and reversals credit the balance
// back, and the provider's signed webhooks update accounts and lines once. The database is
// shared with the other spec files and the tests of this one, so every test uses its own
// couriers and its own payout period, and looks only at its own couriers' lines.

const WEBHOOK_SECRET = 'whsec_flow_test_0123456789';

/** A provider that answers each transfer from a script, by destination, and records every call. */
class FakeGateway implements PayoutGateway {
  enabled = true;
  readonly transfers: { destination: string; amount: Money; idempotencyKey: string }[] = [];
  readonly accounts: { idempotencyKey: string; country: string }[] = [];
  readonly refusals = new Map<string, GatewayRefusal[]>();
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

  createTransfer(request: { destination: string; amount: Money; idempotencyKey: string }) {
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
}

describe('courier pay and payouts (database integration)', () => {
  let db: Persistence;

  beforeAll(() => {
    db = createPersistence();
  });

  afterAll(async () => {
    await db.close();
  });

  /** One test's world: its own clock in its own payout period, couriers, gateway and use cases. */
  function world(code: string, periodIndex: number) {
    const market = marketOf(code);
    const settings = payoutMarkets.get(market.marketId);
    // Each test lives in its own period, weeks apart, so its run is its own.
    const clock = new FixedClock(
      Temporal.Instant.from('2031-01-01T00:00:00Z').add({ hours: 24 * 7 * 3 * periodIndex }),
    );
    const ids = new SequenceIdGenerator(clock);
    const payees = new InMemoryPayeeDirectory();
    const gateway = new FakeGateway();
    const ledger = new PrismaLedgerRepository(db.service);
    const runs = new PrismaPayoutRunRepository(db.service);
    const accounts = new PrismaPayoutAccountRepository(db.service);
    const uow = db.unitOfWork;
    const verifier = new StripeWebhookVerifier([new ProviderSecret(WEBHOOK_SECRET)]);
    const tag = randomUUID().slice(0, 8);
    const courier = (name: string, overrides: Partial<Payee> = {}): string => {
      const courierId = `courier-${tag}-${name}`;
      payees.add(market.marketId, {
        courierId,
        engagement: 'contractor',
        taxRegistered: true,
        businessIdVerified: true,
        ...overrides,
      });
      return courierId;
    };
    const delivered = (courierId: string, overrides: Partial<CompletedDelivery> = {}) => {
      // An hour before the latest cutoff, so the period that just closed includes it.
      const deliveredAt = before();
      return {
        deliveryId: `delivery-${randomUUID()}`,
        courierId,
        vehicle: 'van' as const,
        distanceMetres: 10_000,
        temperature: 'frozen' as const,
        deliveredAt,
        ...overrides,
      };
    };
    const m = (amount: bigint) => money(amount, settings.currency);
    function before() {
      return latestCutoff(settings.schedule, settings.timezone, clock.now()).subtract({ hours: 1 });
    }
    const signed = (body: string) => {
      const t = clock.now().epochMilliseconds / 1000;
      const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
      return { raw: Buffer.from(body), header: `t=${t},v1=${v1}` };
    };
    return {
      market,
      settings,
      clock,
      before,
      gateway,
      courier,
      delivered,
      m,
      signed,
      earn: new RecordDeliveryEarning(ledger, payees, payoutMarkets, uow, clock, ids),
      tip: new RecordTip(ledger, payees, payoutMarkets, uow, clock, ids),
      adjust: new RecordAdjustment(ledger, payees, payoutMarkets, uow, clock, ids),
      reverse: new ReverseDeliveryEarning(ledger, uow, clock, ids),
      balance: new GetCourierBalance(ledger, payoutMarkets, uow),
      payouts: new RunPayouts(
        ledger,
        runs,
        accounts,
        payees,
        gateway,
        payoutMarkets,
        uow,
        clock,
        ids,
      ),
      onboard: new StartPayoutOnboarding(accounts, payees, gateway, payoutMarkets, uow, clock),
      webhook: new HandleProviderWebhook(verifier, accounts, runs, uow, clock),
      lineOf: async (courierId: string) => {
        const found = await uow.run(
          market,
          async () => {
            const rows = await db.service.tx(market).payoutsLine.findMany({
              where: { marketId: market.marketId, tenantId: market.tenantId, courierId },
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                status: true,
                holdReason: true,
                transferId: true,
                attempts: true,
              },
            });
            return ok(rows);
          },
          { readOnly: true },
        );
        return found.ok ? found.value : [];
      },
    };
  }

  /** Onboards a courier and has the provider report the account ready to be paid. */
  async function readyAccount(w: ReturnType<typeof world>, courierId: string): Promise<string> {
    const link = await w.onboard.run(w.market, courierId);
    expect(link.ok).toBe(true);
    const accountId = /setup\/e\/([^/]+)\//.exec(link.ok ? link.value.url : '')![1]!;
    const body = JSON.stringify({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      type: 'account.updated',
      data: { object: { id: accountId, payouts_enabled: true } },
    });
    const { raw, header } = w.signed(body);
    expect(await w.webhook.run(w.market, raw, header)).toEqual({ ok: true, value: 'applied' });
    return accountId;
  }

  const balanceOf = async (w: ReturnType<typeof world>, courierId: string) => {
    const statement = await w.balance.run(w.market, courierId);
    if (!statement.ok) throw new Error(statement.error.code);
    return statement.value.balance.total;
  };

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const index = TEST_MARKETS.indexOf(code) * 20;

    it('records an earning once per delivery, with tax for a registered contractor', async () => {
      const w = world(code, index + 1);
      const registered = w.courier('a');
      const unregistered = w.courier('b', { taxRegistered: false });
      const employee = w.courier('c', { engagement: 'employee' });
      const fact = w.delivered(registered);

      const first = await w.earn.run(w.market, fact);
      const again = await w.earn.run(w.market, fact);
      await w.earn.run(w.market, w.delivered(unregistered));
      const staff = await w.earn.run(w.market, w.delivered(employee));

      // van: base + 10 km + frozen bonus, before tax.
      const rate = w.settings.earnings.vehicles.van!;
      const pay = BigInt(
        rate.perDelivery + rate.perKm * 10 + w.settings.earnings.coldChainBonus.frozen,
      );
      const tax = (pay * BigInt(w.settings.tax.rateBps) + 5000n) / 10_000n;
      expect(first.ok && first.value.entry).toEqual(
        expect.objectContaining({ kind: 'earning', amount: w.m(pay), tax: w.m(tax) }),
      );
      expect(again).toEqual({
        ok: true,
        value: expect.objectContaining({ recorded: false }) as unknown,
      });
      expect(await balanceOf(w, registered)).toEqual(w.m(pay + tax));
      expect(await balanceOf(w, unregistered)).toEqual(w.m(pay));
      expect(staff.ok && staff.value).toEqual(
        expect.objectContaining({
          recorded: true,
          earning: expect.objectContaining({ total: w.m(0n) }) as unknown,
        }),
      );
      expect(staff.ok && staff.value.entry).toBeUndefined();
      expect(await balanceOf(w, employee)).toEqual(w.m(0n));
    });

    it('refuses a courier fleet does not know', async () => {
      const w = world(code, index + 2);

      expect(await w.earn.run(w.market, w.delivered('courier-nobody'))).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'payouts.unknown-courier' }) as unknown,
      });
    });

    it('pays a closed period once: one line per courier, one transfer per line, balance to zero', async () => {
      const w = world(code, index + 3);
      const paid = w.courier('paid');
      const noAccount = w.courier('no-account');
      const account = await readyAccount(w, paid);
      await w.earn.run(w.market, w.delivered(paid));
      await w.tip.run(w.market, {
        deliveryId: 'tip-delivery',
        courierId: paid,
        amount: w.m(500n),
        occurredAt: w.before(),
      });
      await w.earn.run(w.market, w.delivered(noAccount));
      const owed = await balanceOf(w, paid);

      const tick = await w.payouts.run(w.market);
      const second = await w.payouts.run(w.market);

      expect(tick.ok && tick.value.opened).toBeDefined();
      expect(second.ok && second.value.opened).toBeUndefined();
      expect(w.gateway.transfers.filter((t) => t.destination === account)).toEqual([
        expect.objectContaining({
          amount: owed,
          idempotencyKey: expect.stringMatching(/^payout-line-/) as unknown,
        }),
      ]);
      expect(await w.lineOf(paid)).toEqual([
        expect.objectContaining({
          status: 'transferred',
          transferId: expect.stringMatching(/^tr_/) as unknown,
        }),
      ]);
      expect(await w.lineOf(noAccount)).toEqual([
        expect.objectContaining({ status: 'held', holdReason: 'no-payout-account' }),
      ]);
      expect(await balanceOf(w, paid)).toEqual(w.m(0n));
      expect((await balanceOf(w, noAccount)).amount).toBeGreaterThan(0n);
    });

    it('credits back a transfer refused for good, and pays it in the next period', async () => {
      const w = world(code, index + 4);
      const courierId = w.courier('refused');
      const account = await readyAccount(w, courierId);
      await w.earn.run(w.market, w.delivered(courierId));
      const owed = await balanceOf(w, courierId);
      w.gateway.refusals.set(account, [{ code: 'stripe.account_invalid', transient: false }]);

      const tick = await w.payouts.run(w.market);

      expect(tick.ok && tick.value.failed).toBeGreaterThanOrEqual(1);
      expect(await w.lineOf(courierId)).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect(await balanceOf(w, courierId)).toEqual(owed);

      w.clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.payouts.run(w.market);
      expect((await w.lineOf(courierId)).map((line) => line.status)).toEqual([
        'failed',
        'transferred',
      ]);
      expect(await balanceOf(w, courierId)).toEqual(w.m(0n));
    });

    it('retries a transient refusal on the next tick with the same idempotency key', async () => {
      const w = world(code, index + 5);
      const courierId = w.courier('flaky');
      const account = await readyAccount(w, courierId);
      await w.earn.run(w.market, w.delivered(courierId));
      w.gateway.refusals.set(account, [{ code: 'stripe.unreachable', transient: true }]);

      await w.payouts.run(w.market);
      expect(await w.lineOf(courierId)).toEqual([
        expect.objectContaining({ status: 'pending', attempts: 1 }),
      ]);
      await w.payouts.run(w.market);

      const keys = w.gateway.transfers
        .filter((t) => t.destination === account)
        .map((t) => t.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(await w.lineOf(courierId)).toEqual([
        expect.objectContaining({ status: 'transferred', attempts: 2 }),
      ]);
    });

    it('keeps the debit of a line out of transient attempts, and never pays it again', async () => {
      const w = world(code, index + 10);
      const courierId = w.courier('unresolved');
      const account = await readyAccount(w, courierId);
      await w.earn.run(w.market, w.delivered(courierId));
      w.gateway.refusals.set(
        account,
        Array.from({ length: MAX_TRANSFER_ATTEMPTS }, () => ({
          code: 'stripe.unreachable',
          transient: true,
        })),
      );

      for (let tick = 0; tick < MAX_TRANSFER_ATTEMPTS; tick += 1) await w.payouts.run(w.market);
      expect(await w.lineOf(courierId)).toEqual([
        expect.objectContaining({ status: 'unresolved', attempts: MAX_TRANSFER_ATTEMPTS }),
      ]);
      expect(await balanceOf(w, courierId)).toEqual(w.m(0n));

      w.clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.payouts.run(w.market);
      expect(await w.lineOf(courierId)).toHaveLength(1);
      expect(w.gateway.transfers.filter((t) => t.destination === account)).toHaveLength(
        MAX_TRANSFER_ATTEMPTS,
      );
    });

    it('marks a reversed transfer once, and credits no balance with it (an operator clawback)', async () => {
      const w = world(code, index + 6);
      const courierId = w.courier('reversed');
      await readyAccount(w, courierId);
      await w.earn.run(w.market, w.delivered(courierId));
      await w.payouts.run(w.market);
      const [line] = await w.lineOf(courierId);
      const body = JSON.stringify({
        id: `evt_${randomUUID().replaceAll('-', '')}`,
        type: 'transfer.reversed',
        data: {
          object: {
            id: line!.transferId,
            amount_reversed: 300,
            currency: w.settings.currency.toLowerCase(),
          },
        },
      });
      const { raw, header } = w.signed(body);

      expect(await w.webhook.run(w.market, raw, header)).toEqual({ ok: true, value: 'applied' });
      expect(await w.webhook.run(w.market, raw, header)).toEqual({ ok: true, value: 'duplicate' });
      expect(await balanceOf(w, courierId)).toEqual(w.m(0n));
      expect(await w.lineOf(courierId)).toEqual([expect.objectContaining({ status: 'reversed' })]);
      w.clock.advance(Temporal.Duration.from({ hours: 24 * 7 }));
      await w.payouts.run(w.market);
      expect(await w.lineOf(courierId)).toHaveLength(1);
    });

    it('refuses a webhook that was not signed with the endpoint secret', async () => {
      const w = world(code, index + 7);
      const body = JSON.stringify({
        id: 'evt_forged',
        type: 'account.updated',
        data: { object: {} },
      });
      const forged = `t=${w.clock.now().epochMilliseconds / 1000},v1=${'a'.repeat(64)}`;

      expect(await w.webhook.run(w.market, Buffer.from(body), forged)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'payouts.webhook-signature-invalid' }) as unknown,
      });
    });

    it('creates one provider account per courier, and none for an employee', async () => {
      const w = world(code, index + 8);
      const courierId = w.courier('onboard');
      const employee = w.courier('staff', { engagement: 'employee' });

      const first = await w.onboard.run(w.market, courierId);
      const second = await w.onboard.run(w.market, courierId);

      expect(first.ok && second.ok).toBe(true);
      expect(w.gateway.accounts).toEqual([
        {
          country: w.settings.provider.accountCountry,
          idempotencyKey: `payout-account-${code}-${w.market.tenantId}-${courierId}`,
          metadata: expect.anything() as unknown,
        },
      ]);
      expect(await w.onboard.run(w.market, employee)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'payouts.not-a-contractor' }) as unknown,
      });
      w.gateway.enabled = false;
      expect(await w.onboard.run(w.market, courierId)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'payouts.provider-unavailable' }) as unknown,
      });
    });

    it('reverses what a delivery credited, once, and records an operator adjustment once', async () => {
      const w = world(code, index + 9);
      const courierId = w.courier('adjusted');
      const fact = w.delivered(courierId);
      await w.earn.run(w.market, fact);
      await w.tip.run(w.market, {
        deliveryId: fact.deliveryId,
        courierId,
        amount: w.m(200n),
        occurredAt: fact.deliveredAt,
      });

      const reversed = await w.reverse.run(w.market, fact.deliveryId);
      const again = await w.reverse.run(w.market, fact.deliveryId);
      expect(reversed.ok && reversed.value.reversals).toHaveLength(2);
      expect(again.ok && again.value.reversals).toHaveLength(0);
      expect(await balanceOf(w, courierId)).toEqual(w.m(0n));

      const key = `ops-${randomUUID()}`;
      const bonus = { courierId, amount: w.m(1000n), reason: 'bonus' as const, key };
      expect((await w.adjust.run(w.market, bonus)).ok).toBe(true);
      expect(await w.adjust.run(w.market, bonus)).toEqual({
        ok: true,
        value: expect.objectContaining({ recorded: false }) as unknown,
      });
      const tax = (1000n * BigInt(w.settings.tax.rateBps)) / 10_000n;
      expect(await balanceOf(w, courierId)).toEqual(w.m(1000n + tax));
    });
  });

  it('keeps each Market to its own ledger', async () => {
    const au = world('AU', 50);
    const zz = world('ZZ', 50);
    const courierId = au.courier('shared');
    zz.courier('shared');
    await au.earn.run(au.market, { ...au.delivered(courierId) });

    const otherMarket: MarketContext = zz.market;
    const statement = await zz.balance.run(otherMarket, courierId);
    expect(statement.ok && statement.value.entries).toEqual([]);
  });
});
