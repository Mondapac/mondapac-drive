import { geoPoint } from '@mondapac-drive/shared-kernel';
import { AU, dispatchSettings, ZZ } from '../../../../test/support/dispatch-markets';
import { coarsePoint, stopsOf } from './offer-stops';
import type { DeliveryForDispatch } from './ports';

// What an offer shows before accept (security L3): areas, never addresses, and a drop-off point
// on the Market's grid.

const delivery = (overrides: Partial<DeliveryForDispatch> = {}): DeliveryForDispatch => ({
  status: 'DISPATCHING',
  serviceAreaCode: 'area-1',
  pickup: { suburb: '  Pickup Vale ', postcode: '4000', point: geoPoint(-27.4698, 153.0251) },
  dropoff: { suburb: null, postcode: '4101', point: geoPoint(-27.48765, 153.01234) },
  distanceMetres: 4200,
  weightGrams: 5000,
  volumeLitres: 20,
  temperature: 'chilled',
  vehicle: 'motorbike',
  ...overrides,
});

describe.each([
  ['AU', AU, 3],
  ['ZZ', ZZ, 2],
] as const)('offer stops in %s', (_code, marketId, decimals) => {
  const settings = dispatchSettings.get(marketId);

  it("snaps the drop-off point to the Market's grid and keeps the suburbs and postcodes", () => {
    expect(settings.offerPointDecimals).toBe(decimals);
    const stops = stopsOf(delivery(), settings);
    const cell = 10 ** -decimals;
    expect(Math.abs(stops.dropoff.lat - -27.48765)).toBeLessThanOrEqual(cell / 2);
    expect(Math.abs(stops.dropoff.lng - 153.01234)).toBeLessThanOrEqual(cell / 2);
    expect(stops.dropoff).toEqual(coarsePoint(geoPoint(-27.48765, 153.01234), decimals));
    // Every point of one cell gives the same answer.
    expect(coarsePoint(geoPoint(-27.48765 + cell / 10, 153.01234), decimals)).toEqual(
      stops.dropoff,
    );
    expect(stops).toMatchObject({
      pickupArea: { suburb: 'Pickup Vale', postcode: '4000' },
      dropoffArea: { suburb: null, postcode: '4101' },
      tripDistanceMetres: 4200,
    });
  });

  it('shows no suburb that is blank, too long or carries control characters', () => {
    for (const suburb of ['   ', 'x'.repeat(201), 'New\u0000Town', 'New‮Town', undefined]) {
      const stops = stopsOf(
        delivery({ pickup: { suburb, postcode: '4000', point: geoPoint(-27.47, 153.02) } }),
        settings,
      );
      expect(stops.pickupArea.suburb).toBeNull();
    }
  });
});
