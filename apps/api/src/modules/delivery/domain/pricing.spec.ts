import { AU, markets, ZZ } from '../../../../test/support/delivery-markets';
import { parcel } from './parcel';
import { priceDelivery } from './pricing';

describe('priceDelivery', () => {
  const au = markets.get(AU);
  const zz = markets.get(ZZ);

  it('picks the cheapest vehicle that can carry the parcel, tax included', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'ambient'),
      distanceMetres: 4000,
      mode: 'on_demand',
    });
    expect(quote.vehicle).toBe('bicycle');
    expect(quote.total).toEqual({ amount: 1180n, currency: 'AUD' });
    expect(quote.tax).toEqual({ amount: 107n, currency: 'AUD' });
  });

  it('only offers vehicles that can keep a frozen parcel frozen', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'frozen'),
      distanceMetres: 4000,
      mode: 'on_demand',
    });
    expect(quote.vehicle).toBe('car');
    expect(quote.breakdown.coldChain.amount).toBe(500n);
    expect(quote.total.amount).toBe(2100n);
  });

  it('discounts scheduled deliveries', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'chilled'),
      distanceMetres: 4000,
      mode: 'scheduled',
    });
    expect(quote.breakdown.scheduledDiscount.amount).toBe(-148n);
    expect(quote.total.amount).toBe(1332n);
    expect(quote.tax.amount).toBe(121n);
  });

  it('honours a requested vehicle', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'ambient'),
      distanceMetres: 4000,
      mode: 'on_demand',
      vehicle: 'van',
    });
    expect(quote.vehicle).toBe('van');
    expect(quote.total.amount).toBe(3380n);
  });

  it('adds tax on top in a Market that quotes prices without tax', () => {
    const quote = priceDelivery(zz, {
      parcel: parcel(5000, 20, 'ambient'),
      distanceMetres: 4000,
      mode: 'on_demand',
    });
    expect(quote.vehicle).toBe('motorbike');
    expect(quote.tax).toEqual({ amount: 135n, currency: 'JPY' });
    expect(quote.total).toEqual({ amount: 1035n, currency: 'JPY' });
  });

  it('uses each Market’s own vehicles and surcharges', () => {
    const quote = priceDelivery(zz, {
      parcel: parcel(5000, 20, 'chilled'),
      distanceMetres: 4000,
      mode: 'scheduled',
    });
    expect(quote.vehicle).toBe('van');
    expect(quote.total.amount).toBe(3050n + 458n);
  });

  it('refuses a parcel no vehicle can carry', () => {
    expect(() =>
      priceDelivery(au, {
        parcel: parcel(600_000, 20, 'ambient'),
        distanceMetres: 4000,
        mode: 'on_demand',
      }),
    ).toThrow(expect.objectContaining({ code: 'quote.no-vehicle' }) as Error);
  });
});
