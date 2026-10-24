import { money, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { AU, payoutMarkets, ZZ } from '../../../../test/support/payouts-markets';
import type { Balance } from './ledger';
import type { Payee } from './payee';
import {
  accountUpdated,
  lineHeldBeforeTransfer,
  lineRefused,
  lineReversed,
  lineSettled,
  SETTLED_NOT_TRANSFERRED,
  lineTransferred,
  MAX_TRANSFER_ATTEMPTS,
  planPayoutRun,
  type CourierBalance,
  type PayoutAccount,
  type PayoutLine,
} from './payout-run';

const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const cutoff = Temporal.Instant.from('2026-11-01T17:00:00Z');

function plan(
  code: 'AU' | 'ZZ',
  balances: readonly CourierBalance[],
  payees: readonly Payee[],
  accounts: readonly PayoutAccount[],
) {
  let counter = 0;
  return planPayoutRun(payoutMarkets.get(code === 'AU' ? AU : ZZ), {
    runId: 'run-1' as Id<'PayoutRun'>,
    cutoff,
    now,
    balances,
    payees: new Map(payees.map((payee) => [payee.courierId, payee])),
    accounts: new Map(accounts.map((account) => [account.courierId, account])),
    newLineId: () => `line-${(counter += 1)}` as Id<'PayoutLine'>,
  });
}

const contractor = (courierId: string, overrides: Partial<Payee> = {}): Payee => ({
  courierId,
  engagement: 'contractor',
  taxRegistered: true,
  businessIdVerified: true,
  ...overrides,
});
const account = (courierId: string, payoutsEnabled = true): PayoutAccount => ({
  courierId,
  providerAccountId: `acct_${courierId.replaceAll('-', '')}`,
  payoutsEnabled,
  createdAt: now,
  updatedAt: now,
});

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('planPayoutRun in %s', (code, currency) => {
  const m = (amount: bigint) => money(amount, currency);
  const balance = (courierId: string, amount: bigint, tax = 0n): CourierBalance => ({
    courierId,
    balance: { amount: m(amount), tax: m(tax), total: m(amount + tax) } satisfies Balance,
  });

  it('pays a contractor with an account the whole balance, tax included', () => {
    const { run, lines } = plan(
      code,
      [balance('c-1', 5000n, 500n)],
      [contractor('c-1')],
      [account('c-1')],
    );

    expect(lines).toEqual([
      expect.objectContaining({
        courierId: 'c-1',
        amount: m(5000n),
        tax: m(500n),
        status: 'pending',
        destination: 'acct_c1',
        attempts: 0,
        version: 1,
      }),
    ]);
    expect(run.total).toEqual(m(5500n));
    expect(run.cutoff).toEqual(cutoff);
  });

  it('holds what cannot be paid now, with the reason, and leaves it out of the total', () => {
    const { run, lines } = plan(
      code,
      [
        balance('c-1', 5000n),
        balance('c-2', 5000n),
        balance('c-3', 5000n),
        balance('c-4', 5000n),
        balance('c-5', 5000n),
      ],
      [
        contractor('c-1'),
        contractor('c-2'),
        { ...contractor('c-3'), engagement: 'employee' },
        contractor('c-4', { businessIdVerified: false }),
      ],
      [account('c-2', false), account('c-4')],
    );

    expect(lines.map((line) => [line.courierId, line.status, line.holdReason])).toEqual([
      ['c-1', 'held', 'no-payout-account'],
      ['c-2', 'held', 'payouts-disabled'],
      ['c-3', 'held', 'paid-by-payroll'],
      // AU pays a contractor only with a verified ABN; ZZ has no such rule.
      code === 'AU' ? ['c-4', 'held', 'missing-business-id'] : ['c-4', 'pending', undefined],
      ['c-5', 'held', 'unknown-courier'],
    ]);
    expect(run.total).toEqual(m(code === 'AU' ? 0n : 5000n));
  });

  it('leaves a zero, negative or below-minimum balance for a later run (AU minimum 10.00, ZZ none)', () => {
    const { lines } = plan(
      code,
      [balance('c-1', 0n), balance('c-2', -300n), balance('c-3', 999n), balance('c-4', 1000n)],
      ['c-1', 'c-2', 'c-3', 'c-4'].map((id) => contractor(id)),
      ['c-1', 'c-2', 'c-3', 'c-4'].map((id) => account(id)),
    );

    expect(lines.map((line) => line.courierId)).toEqual(code === 'AU' ? ['c-4'] : ['c-3', 'c-4']);
  });

  it('refuses a balance in another currency', () => {
    const other = currency === 'AUD' ? 'JPY' : 'AUD';
    const foreign: CourierBalance = {
      courierId: 'c-1',
      balance: { amount: money(1n, other), tax: money(0n, other), total: money(1n, other) },
    };

    expect(() => plan(code, [foreign], [contractor('c-1')], [account('c-1')])).toThrow(
      expect.objectContaining({ code: 'payouts.currency-mismatch' }) as Error,
    );
  });
});

describe('a payout line', () => {
  const m = (amount: bigint) => money(amount, 'AUD');
  const pending = (): PayoutLine =>
    plan(
      'AU',
      [{ courierId: 'c-1', balance: { amount: m(1000n), tax: m(100n), total: m(1100n) } }],
      [contractor('c-1')],
      [account('c-1')],
    ).lines[0]!;
  const later = now.add({ minutes: 1 });

  it('records the transfer the provider accepted', () => {
    const line = lineTransferred(pending(), 'tr_1', later);

    expect(line).toEqual(
      expect.objectContaining({
        status: 'transferred',
        transferId: 'tr_1',
        attempts: 1,
        version: 2,
      }),
    );
    expect(line.updatedAt).toEqual(later);
  });

  it('stays pending on a transient refusal until the last attempt, then is unresolved', () => {
    let line = pending();
    for (let attempt = 1; attempt < MAX_TRANSFER_ATTEMPTS; attempt += 1) {
      line = lineRefused(line, { code: 'stripe.unreachable', transient: true }, later);
      expect(line.status).toBe('pending');
    }
    line = lineRefused(line, { code: 'stripe.unreachable', transient: true }, later);
    const settled = line;

    expect(line).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        attempts: MAX_TRANSFER_ATTEMPTS,
        lastErrorCode: 'stripe.unreachable',
      }),
    );
    expect(() =>
      lineRefused(settled, { code: 'stripe.unreachable', transient: true }, later),
    ).toThrow(expect.objectContaining({ code: 'payouts.line-state' }) as Error);
  });

  it('fails at once on a permanent refusal, and then changes no more', () => {
    const line = lineRefused(
      pending(),
      { code: 'stripe.balance_insufficient', transient: false },
      later,
    );

    expect(line.status).toBe('failed');
    expect(() => lineTransferred(line, 'tr_1', later)).toThrow(
      expect.objectContaining({ code: 'payouts.line-state' }) as Error,
    );
  });

  it('answers each newly reversed portion of a transfer once', () => {
    const transferred = lineTransferred(pending(), 'tr_1', later);
    const partly = lineReversed(transferred, m(300n), later);
    const again = lineReversed(partly.line, m(300n), later);
    const whole = lineReversed(partly.line, m(1100n), later);

    expect(partly.newlyReversed).toEqual(m(300n));
    expect(partly.line).toEqual(
      expect.objectContaining({ status: 'reversed', reversedAmount: m(300n) }),
    );
    expect(again.newlyReversed).toEqual(m(0n));
    expect(again.line).toBe(partly.line);
    expect(whole.newlyReversed).toEqual(m(800n));
    expect(() => lineReversed(transferred, m(1101n), later)).toThrow(
      expect.objectContaining({ code: 'payouts.invalid-reversal' }) as Error,
    );
    expect(() => lineReversed(pending(), m(1n), later)).toThrow(
      expect.objectContaining({ code: 'payouts.line-state' }) as Error,
    );
  });
});

describe('a payout line, held or settled', () => {
  const m = (amount: bigint) => money(amount, 'AUD');
  const pending = (): PayoutLine =>
    plan(
      'AU',
      [{ courierId: 'c-1', balance: { amount: m(1000n), tax: m(100n), total: m(1100n) } }],
      [contractor('c-1')],
      [account('c-1')],
    ).lines[0]!;
  const later = now.add({ minutes: 1 });
  const unresolved = (): PayoutLine => {
    let line = pending();
    for (let attempt = 0; attempt < MAX_TRANSFER_ATTEMPTS; attempt += 1) {
      line = lineRefused(line, { code: 'stripe.unreachable', transient: true }, later);
    }
    return line;
  };

  it('holds a pending line before its transfer, with the reason (L5)', () => {
    expect(lineHeldBeforeTransfer(pending(), 'payouts-disabled', later)).toEqual(
      expect.objectContaining({ status: 'held', holdReason: 'payouts-disabled', version: 2 }),
    );
    expect(() =>
      lineHeldBeforeTransfer(lineTransferred(pending(), 'tr_1', later), 'payouts-disabled', later),
    ).toThrow(expect.objectContaining({ code: 'payouts.line-state' }) as Error);
  });

  it('settles an unresolved line as transferred, or as failed when the provider holds none', () => {
    const line = unresolved();
    expect(line.status).toBe('unresolved');

    expect(lineSettled(line, { found: true, transferId: 'tr_9' }, later)).toEqual(
      expect.objectContaining({ status: 'transferred', transferId: 'tr_9' }),
    );
    expect(lineSettled(line, { found: false }, later)).toEqual(
      expect.objectContaining({ status: 'failed', lastErrorCode: SETTLED_NOT_TRANSFERRED }),
    );
    expect(() => lineSettled(pending(), { found: false }, later)).toThrow(
      expect.objectContaining({ code: 'payouts.line-state' }) as Error,
    );
  });
});

describe('an account update (L1)', () => {
  const stored = { ...account('c-1', false), providerStateAt: now };

  it('applies a report as new as the stored state or newer', () => {
    const later = now.add({ seconds: 5 });
    expect(accountUpdated(stored, { payoutsEnabled: true, stateAt: now }, later)).toEqual(
      expect.objectContaining({ payoutsEnabled: true, providerStateAt: now, updatedAt: later }),
    );
    expect(accountUpdated(account('c-1'), { payoutsEnabled: false, stateAt: now }, later)).toEqual(
      expect.objectContaining({ payoutsEnabled: false }),
    );
  });

  it('changes nothing for a report older than the stored state', () => {
    expect(
      accountUpdated(
        stored,
        { payoutsEnabled: true, stateAt: now.subtract({ seconds: 1 }) },
        now,
      ),
    ).toBeUndefined();
  });
});
