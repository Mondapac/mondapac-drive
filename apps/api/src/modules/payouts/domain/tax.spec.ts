import { money } from '@mondapac-drive/shared-kernel';
import { AU, payoutMarkets, ZZ } from '../../../../test/support/payouts-markets';
import type { Payee } from './payee';
import { payTaxOn } from './tax';

const contractor = (taxRegistered: boolean): Payee => ({
  courierId: 'courier-1',
  engagement: 'contractor',
  taxRegistered,
  businessIdVerified: true,
});

describe('payTaxOn', () => {
  const au = payoutMarkets.get(AU);
  const zz = payoutMarkets.get(ZZ);

  it('adds the Market rate on top of a registered contractor’s pay, rounded half-up', () => {
    expect(payTaxOn(au, contractor(true), 'service', money(1572n, 'AUD'))).toEqual(
      money(157n, 'AUD'),
    );
    expect(payTaxOn(au, contractor(true), 'service', money(1575n, 'AUD'))).toEqual(
      money(158n, 'AUD'),
    );
    expect(payTaxOn(zz, contractor(true), 'service', money(860n, 'JPY'))).toEqual(
      money(129n, 'JPY'),
    );
  });

  it('adds nothing for an unregistered contractor or an employee', () => {
    const employee: Payee = { ...contractor(true), engagement: 'employee' };

    expect(payTaxOn(au, contractor(false), 'service', money(1572n, 'AUD')).amount).toBe(0n);
    expect(payTaxOn(au, employee, 'service', money(1572n, 'AUD')).amount).toBe(0n);
    expect(payTaxOn(zz, contractor(false), 'tip', money(300n, 'JPY')).amount).toBe(0n);
  });

  it('taxes tips only where the Market says so', () => {
    expect(payTaxOn(au, contractor(true), 'tip', money(500n, 'AUD')).amount).toBe(0n);
    expect(payTaxOn(zz, contractor(true), 'tip', money(300n, 'JPY'))).toEqual(money(45n, 'JPY'));
  });

  it('gives a deduction a negative tax', () => {
    expect(payTaxOn(au, contractor(true), 'service', money(-105n, 'AUD'))).toEqual(
      money(-11n, 'AUD'),
    );
  });
});
