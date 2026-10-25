import { addMoney, Temporal, type MarketId } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { AU, payoutMarkets, ZZ } from '../../../../../test/support/payouts-markets';
import { nonSystemCallers, openGate } from '../../../../../test/support/system-only-denial';
import { earningFor } from '../../domain/earnings';
import type { Payee } from '../../domain/payee';
import { payTaxOn } from '../../domain/tax';
import { InMemoryPayeeDirectory } from '../../infrastructure/in-memory-payee-directory';
import type { PayoutsDependencies } from '../dependencies';
import type { PayeeDirectory } from '../ports';
import { EarningsQuote, type OfferToQuote } from './quote-offer-earning.use-case';

// The offer quote prices with the earning subscriber's own domain functions; that the quote
// equals the earning the ledger records is checked on the database (payouts-flow.db-spec.ts).

const offer: OfferToQuote = {
  deliveryId: 'd-1',
  vehicle: 'van',
  distanceMetres: 7300,
  temperature: 'chilled',
};

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
] as const)('the offer earnings quote in %s', (code, marketId: MarketId) => {
  const settings = payoutMarkets.get(marketId);
  const callers = nonSystemCallers(code);
  const courier = callers.courier!;
  const courierId = courier.actor.kind === 'authenticated' ? courier.actor.accountId : '';
  const clock = new FixedClock(Temporal.Instant.from('2026-11-02T08:00:00Z'));

  function quoteWith(payees: PayeeDirectory): EarningsQuote {
    const deps = { payees, settings: payoutMarkets, clock } as unknown as PayoutsDependencies;
    return new EarningsQuote(openGate(), deps);
  }
  function withPayee(overrides: Partial<Payee>): EarningsQuote {
    const payees = new InMemoryPayeeDirectory();
    payees.add(marketId, {
      courierId,
      engagement: 'contractor',
      taxRegistered: false,
      businessIdVerified: true,
      ...overrides,
    });
    return quoteWith(payees);
  }
  const earned = (payee: Payee) => {
    const { total } = earningFor(settings, payee.engagement, {
      ...offer,
      courierId,
      deliveredAt: clock.now(),
    });
    return addMoney(total, payTaxOn(settings, payee, 'service', total));
  };

  it("quotes a contractor's earning in the Market's currency, with the tax Drive adds", async () => {
    for (const taxRegistered of [false, true]) {
      const payee: Payee = {
        courierId,
        engagement: 'contractor',
        taxRegistered,
        businessIdVerified: true,
      };
      const quoted = await withPayee(payee).forOffer(courier, offer);
      expect(quoted).toEqual(earned(payee));
      expect(quoted?.currency).toBe(settings.currency);
      expect(quoted!.amount > 0n).toBe(true);
    }
  });

  it('quotes nothing for an employee, an unknown courier or a delivery it cannot price', async () => {
    expect(await withPayee({ engagement: 'employee' }).forOffer(courier, offer)).toBeNull();
    expect(await quoteWith(new InMemoryPayeeDirectory()).forOffer(courier, offer)).toBeNull();
    expect(await withPayee({}).forOffer(courier, { ...offer, distanceMetres: -1 })).toBeNull();
    // ZZ pays no courier by car.
    const byCar = await withPayee({}).forOffer(courier, { ...offer, vehicle: 'car' });
    expect(byCar === null).toBe(code === 'ZZ');
  });

  it('quotes nothing when fleet cannot answer, so the offer still shows', async () => {
    const down: PayeeDirectory = { payees: () => Promise.reject(new Error('fleet down')) };
    expect(await quoteWith(down).forOffer(courier, offer)).toBeNull();
  });

  it('quotes only for a signed-in courier, never for another actor', async () => {
    const quote = withPayee({});
    for (const name of ['merchant', 'admin', 'anonymous']) {
      expect({ name, quoted: await quote.forOffer(callers[name]!, offer) }).toEqual({
        name,
        quoted: null,
      });
    }
    const refused = await quote.execute(callers.admin!, offer);
    expect(!refused.ok && refused.error.code).toBe('access.denied');
  });
});
