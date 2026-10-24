import { AU, markets, ZZ } from '../../../../test/support/markets';
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
    expect(quote.total).toEqual({ amount: 1180, currency: 'AUD' });
    expect(quote.tax).toEqual({ amount: 107, currency: 'AUD' });
  });

  it('only offers vehicles that can keep a frozen parcel frozen', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'frozen'),
      distanceMetres: 4000,
      mode: 'on_demand',
    });
    expect(quote.vehicle).toBe('car');
    expect(quote.breakdown.coldChain.amount).toBe(500);
    expect(quote.total.amount).toBe(2100);
  });

  it('discounts scheduled deliveries', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'chilled'),
      distanceMetres: 4000,
      mode: 'scheduled',
    });
    expect(quote.breakdown.scheduledDiscount.amount).toBe(-148);
    expect(quote.total.amount).toBe(1332);
    expect(quote.tax.amount).toBe(121);
  });

  it('honours a requested vehicle', () => {
    const quote = priceDelivery(au, {
      parcel: parcel(5000, 20, 'ambient'),
      distanceMetres: 4000,
      mode: 'on_demand',
      vehicle: 'van',
    });
    expect(quote.vehicle).toBe('van');
    expect(quote.total.amount).toBe(3380);
  });

  it('adds tax on top in a Market that quotes prices without tax', () => {
    const quote = priceDelivery(zz, {
      parcel: parcel(5000, 20, 'ambient'),
      distanceMetres: 4000,
      mode: 'on_demand',
    });
    expect(quote.vehicle).toBe('motorbike');
    expect(quote.tax).toEqual({ amount: 135, currency: 'XTS' });
    expect(quote.total).toEqual({ amount: 1035, currency: 'XTS' });
  });

  it('uses each Market’s own vehicles and surcharges', () => {
    const quote = priceDelivery(zz, {
      parcel: parcel(5000, 20, 'chilled'),
      distanceMetres: 4000,
      mode: 'scheduled',
    });
    expect(quote.vehicle).toBe('van');
    expect(quote.total.amount).toBe(3050 + 458);
  });

  it('refuses a parcel no vehicle can carry', () => {
    expect(() =>
      priceDelivery(au, {
        parcel: parcel(600_000, 20, 'ambient'),
        distanceMetres: 4000,
        mode: 'on_demand',
      }),
    ).toThrow(expect.objectContaining({ code: 'quote.no-vehicle' }));
  });
});
