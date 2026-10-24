import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MarketEchoController } from './support/market-test.controllers';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Residency guard (platform-foundations 5.1 and section 9): a Region Stack refuses every
// Market outside HOSTED_MARKETS. These cases assert answers only, never log lines, so the
// two applications of this file may share nestjs-pino's one logger.

describe.each(TEST_MARKETS)('a Region Stack hosting only %s', (hosted) => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { HOSTED_MARKETS: hosted, LOG_LEVEL: 'silent' },
      controllers: [MarketEchoController],
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves its own market', async () => {
    const response = await request(app.getHttpServer())
      .get('/test/market')
      .set('x-market-id', hosted)
      .expect(200);

    expect(response.body).toEqual({ marketId: hosted, tenantId: 'mondapac', minted: true });
  });

  it.each(TEST_MARKETS.filter((code) => code !== hosted))(
    'refuses %s with market.not-hosted',
    async (other) => {
      const response = await request(app.getHttpServer())
        .get('/test/market')
        .set('x-market-id', other)
        .expect(400);

      expect(response.body).toEqual({ statusCode: 400, code: 'market.not-hosted' });
    },
  );
});
