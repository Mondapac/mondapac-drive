import { money, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from './errors';
import {
  adjustmentEntry,
  balanceOf,
  earningEntry,
  payoutEntry,
  reversalOf,
  tipEntry,
} from './ledger';

const at = Temporal.Instant.from('2026-11-02T00:00:00Z');
let counter = 0;
const id = () => `entry-${(counter += 1)}` as Id<'LedgerEntry'>;
const base = () => ({ id: id(), courierId: 'courier-1', occurredAt: at, recordedAt: at });

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
])('the ledger in %s', (_market, currency) => {
  const m = (amount: bigint) => money(amount, currency);

  it('keys each fact by a reference, so a repeated fact is one entry', () => {
    expect(earningEntry({ ...base(), deliveryId: 'd-1', amount: m(1572n), tax: m(157n) })).toEqual(
      expect.objectContaining({ kind: 'earning', reference: 'earning:d-1' }),
    );
    expect(tipEntry({ ...base(), deliveryId: 'd-1', amount: m(500n), tax: m(0n) }).reference).toBe(
      'tip:d-1',
    );
    expect(
      adjustmentEntry({
        ...base(),
        key: 'ops-0001',
        amount: m(-200n),
        tax: m(-20n),
        reason: 'correction',
      }).reference,
    ).toBe('adjustment:ops-0001');
  });

  it('sums a balance: amounts, taxes and both', () => {
    const entries = [
      earningEntry({ ...base(), deliveryId: 'd-1', amount: m(1572n), tax: m(157n) }),
      tipEntry({ ...base(), deliveryId: 'd-1', amount: m(500n), tax: m(0n) }),
      adjustmentEntry({
        ...base(),
        key: 'ops-0001',
        amount: m(-200n),
        tax: m(-20n),
        reason: 'correction',
      }),
    ];

    expect(balanceOf(entries, currency)).toEqual({
      amount: m(1872n),
      tax: m(137n),
      total: m(2009n),
    });
    expect(balanceOf([], currency).total).toEqual(m(0n));
  });

  it('debits a payout by what the run paid, so the balance returns to zero', () => {
    const earning = earningEntry({ ...base(), deliveryId: 'd-1', amount: m(1572n), tax: m(157n) });
    const paid = balanceOf([earning], currency);
    const payout = payoutEntry({ ...base(), payoutLineId: 'line-1', paid });

    expect(payout).toEqual(
      expect.objectContaining({ kind: 'payout', amount: m(-1572n), tax: m(-157n) }),
    );
    expect(payout.reference).toBe('payout:line-1');
    expect(balanceOf([earning, payout], currency).total).toEqual(m(0n));
  });

  it('reverses an entry wholly, with the opposite sign and a link to it', () => {
    const earning = earningEntry({ ...base(), deliveryId: 'd-1', amount: m(1572n), tax: m(157n) });
    const reversal = reversalOf(earning, {
      ...base(),
      reference: `reversal:${earning.id}`,
      reason: 'delivery-reversed',
    });

    expect(reversal).toEqual(
      expect.objectContaining({
        kind: 'reversal',
        amount: m(-1572n),
        tax: m(-157n),
        deliveryId: 'd-1',
        reversesEntryId: earning.id,
        courierId: earning.courierId,
      }),
    );
    expect(balanceOf([earning, reversal], currency).total).toEqual(m(0n));
  });

  it('reverses part of a payout, splitting the portion between pay and tax', () => {
    const paid = { amount: m(1000n), tax: m(100n), total: m(1100n) };
    const payout = payoutEntry({ ...base(), payoutLineId: 'line-1', paid });
    const reversal = reversalOf(payout, {
      ...base(),
      reference: 'transfer-reversal:line-1:550',
      reason: 'transfer-reversed',
      portion: m(550n),
    });

    expect(reversal.amount).toEqual(m(500n));
    expect(reversal.tax).toEqual(m(50n));
    expect(reversal.payoutLineId).toBe('line-1');
  });

  it('rounds the tax share of a partial reversal toward zero', () => {
    const paid = { amount: m(1000n), tax: m(100n), total: m(1100n) };
    const payout = payoutEntry({ ...base(), payoutLineId: 'line-1', paid });
    const reversal = reversalOf(payout, {
      ...base(),
      reference: 'transfer-reversal:line-1:7',
      reason: 'transfer-reversed',
      portion: m(7n),
    });

    expect(reversal.tax).toEqual(m(0n));
    expect(reversal.amount).toEqual(m(7n));
  });

  it('refuses empty amounts, a portion larger than the entry and a reversal of a reversal', () => {
    const earning = earningEntry({ ...base(), deliveryId: 'd-1', amount: m(100n), tax: m(10n) });
    const reversal = reversalOf(earning, { ...base(), reference: 'r-1', reason: 'correction' });

    expect(() => earningEntry({ ...base(), deliveryId: 'd-2', amount: m(0n), tax: m(0n) })).toThrow(
      PayoutsDomainError,
    );
    expect(() => tipEntry({ ...base(), deliveryId: 'd-2', amount: m(-1n), tax: m(0n) })).toThrow(
      PayoutsDomainError,
    );
    expect(() =>
      adjustmentEntry({ ...base(), key: 'ops-0002', amount: m(0n), tax: m(0n), reason: 'bonus' }),
    ).toThrow(PayoutsDomainError);
    expect(() =>
      payoutEntry({
        ...base(),
        payoutLineId: 'l',
        paid: { amount: m(0n), tax: m(0n), total: m(0n) },
      }),
    ).toThrow(PayoutsDomainError);
    expect(() =>
      reversalOf(earning, { ...base(), reference: 'r-2', reason: 'correction', portion: m(111n) }),
    ).toThrow(expect.objectContaining({ code: 'ledger.invalid-portion' }) as Error);
    expect(() =>
      reversalOf(reversal, { ...base(), reference: 'r-3', reason: 'correction' }),
    ).toThrow(expect.objectContaining({ code: 'ledger.reversal-of-reversal' }) as Error);
  });

  it('refuses a tax with the other sign or in another currency', () => {
    expect(() =>
      earningEntry({ ...base(), deliveryId: 'd-1', amount: m(100n), tax: m(-1n) }),
    ).toThrow(expect.objectContaining({ code: 'ledger.tax-sign' }) as Error);
    const other = currency === 'AUD' ? 'JPY' : 'AUD';
    expect(() =>
      earningEntry({ ...base(), deliveryId: 'd-1', amount: m(100n), tax: money(1n, other) }),
    ).toThrow(expect.objectContaining({ code: 'ledger.currency-mismatch' }) as Error);
  });
});
