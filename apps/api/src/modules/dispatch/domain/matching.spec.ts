import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  AU,
  courier,
  courierId,
  dispatchSettings,
  requirements,
  ZZ,
} from '../../../../test/support/dispatch-markets';
import { canCarry, rankCandidates } from './matching';

const early = Temporal.Instant.from('2026-11-02T08:00:00Z');
const late = Temporal.Instant.from('2026-11-02T09:00:00Z');

describe('canCarry', () => {
  const needs = requirements();

  it('accepts a larger vehicle than the one the delivery was priced for', () => {
    expect(canCarry(courier(1), needs)).toBe(true);
  });

  it.each([
    ['a smaller vehicle', courier(1, { vehicle: { ...courier(1).vehicle, type: 'bicycle' } })],
    ['too little weight', courier(1, { vehicle: { ...courier(1).vehicle, maxWeightGrams: 4999 } })],
    ['too little room', courier(1, { vehicle: { ...courier(1).vehicle, maxVolumeLitres: 19 } })],
    [
      'no cold-chain equipment for a chilled parcel',
      courier(1, { vehicle: { ...courier(1).vehicle, temperatures: ['ambient'] } }),
    ],
    ['another service area', courier(1, { serviceAreaCodes: ['area-2'] })],
  ])('refuses %s', (_case, candidate) => {
    expect(canCarry(candidate, needs)).toBe(false);
  });

  it('needs frozen equipment for a frozen parcel', () => {
    const chilledOnly = courier(1, {
      vehicle: { ...courier(1).vehicle, temperatures: ['ambient', 'chilled'] },
    });

    expect(canCarry(chilledOnly, requirements({ temperature: 'frozen' }))).toBe(false);
    expect(canCarry(chilledOnly, requirements({ temperature: 'chilled' }))).toBe(true);
  });
});

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('rankCandidates in %s', (_name, market) => {
  const { searchRadiusMetres } = dispatchSettings.get(market);
  const rank = (
    available: Parameters<typeof rankCandidates>[1],
    nearby: Parameters<typeof rankCandidates>[2],
    exclude: ReadonlySet<string> = new Set(),
  ) => rankCandidates(requirements(), available, nearby, { searchRadiusMetres, exclude });

  it('ranks by distance first, then by the longest idle time', () => {
    const ranked = rank(
      [courier(1, {}, late), courier(2, {}, early), courier(3, {}, early)],
      [
        { courierId: courierId(1), distanceMetres: 900 },
        { courierId: courierId(2), distanceMetres: 1500 },
        { courierId: courierId(3), distanceMetres: 900 },
      ],
    );

    expect(ranked.map((c) => c.courierId)).toEqual([courierId(3), courierId(1), courierId(2)]);
  });

  it("skips couriers beyond the Market's search radius or with no known position", () => {
    const ranked = rank(
      [courier(1), courier(2), courier(3)],
      [
        { courierId: courierId(1), distanceMetres: searchRadiusMetres },
        { courierId: courierId(2), distanceMetres: searchRadiusMetres + 1 },
      ],
    );

    expect(ranked.map((c) => c.courierId)).toEqual([courierId(1)]);
  });

  it('skips couriers who cannot carry the parcel, and excluded couriers', () => {
    const ranked = rank(
      [
        courier(1, { serviceAreaCodes: ['area-2'] }),
        courier(2),
        courier(3, { vehicle: { ...courier(3).vehicle, type: 'bicycle' } }),
      ],
      [1, 2, 3].map((n) => ({ courierId: courierId(n), distanceMetres: 100 * n })),
      new Set([courierId(2)]),
    );

    expect(ranked).toEqual([]);
  });

  it('does not depend on the order of the inputs', () => {
    const available = [courier(1), courier(2), courier(3)];
    const nearby = [1, 2, 3].map((n) => ({ courierId: courierId(n), distanceMetres: 500 }));

    expect(rank([...available].reverse(), [...nearby].reverse())).toEqual(rank(available, nearby));
  });
});
