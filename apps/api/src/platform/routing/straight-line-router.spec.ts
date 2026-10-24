import { geoPoint } from '@mondapac-drive/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { greatCircleMetres, StraightLineRouter } from './straight-line-router';

const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

describe('greatCircleMetres', () => {
  it('is about 111.2 km per degree of latitude', () => {
    expect(greatCircleMetres(geoPoint(0, 0), geoPoint(1, 0))).toBeCloseTo(111_195, -1);
  });
});

describe.each(TEST_MARKET_IDS)('StraightLineRouter (%s)', (marketId) => {
  const { straightLine } = markets.get(marketId)!.routing!;
  const router = new StraightLineRouter(straightLine);

  it("applies the Market's road factor and the vehicle's speed", () => {
    const from = geoPoint(0, 0);
    const to = geoPoint(0.1, 0);
    const distance = Math.round(greatCircleMetres(from, to) * straightLine.roadFactor);
    const estimate = router.route(from, to, 'car');
    expect(estimate).toEqual({
      distanceMetres: distance,
      durationSeconds: Math.round(distance / ((straightLine.speedsKmh.car * 1000) / 3600)),
      source: 'straight_line',
    });
    expect(router.route(from, to, 'bicycle').durationSeconds).toBeGreaterThan(
      router.route(from, to, 'motorbike').durationSeconds,
    );
  });

  it('is zero for the same point', () => {
    expect(router.route(geoPoint(1, 1), geoPoint(1, 1), 'van')).toMatchObject({
      distanceMetres: 0,
      durationSeconds: 0,
    });
  });
});
