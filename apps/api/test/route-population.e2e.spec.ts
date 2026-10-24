import { Controller, Get, Post } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  AdminDeliveryController,
  CourierDeliveryController,
  MerchantDeliveryController,
} from '../src/modules/delivery/presentation/delivery.controller';
import { AdminMerchantsController } from '../src/modules/identity/presentation/admin-merchants.controller';
import { AdminSessionController } from '../src/modules/identity/presentation/admin-session.controller';
import { CourierSessionController } from '../src/modules/identity/presentation/courier-session.controller';
import { RoutePopulationError } from '../src/platform/call-context/route-population.check';
import {
  ReadsSession,
  RoutePopulation,
  routePopulationOf,
} from '../src/platform/call-context/route-population.decorator';
import { isMarketContextExempt } from '../src/platform/market-context/market-context.guard';
import { NoMarketContext } from '../src/platform/market-context/no-market-context.decorator';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// Route populations at start-up and over HTTP (identity design 6.4; Ali's ruling and Hassan's
// review of 2026-10-08): the application refuses to boot when a controller breaks a rule, and
// the real routes refuse unsafe admin requests without both origin headers.

@Controller('test/route-population/missing')
class MissingPopulationController {
  @Get()
  read(): void {}
}

@RoutePopulation('courier')
@Controller('test/route-population/method-level')
class MethodLevelPopulationController {
  @Post()
  @(RoutePopulation('admin') as unknown as MethodDecorator)
  write(): void {}
}

@NoMarketContext()
@Controller('test/route-population/session-without-population')
class SessionWithoutPopulationController {
  @Get()
  @ReadsSession()
  read(): void {}
}

@NoMarketContext()
@Controller('test/route-population/exempt-unsafe')
class ExemptUnsafeController {
  @Post()
  write(): void {}
}

const fakes = new IdentityFakes();

describe('route populations at start-up', () => {
  it.each([
    [
      MissingPopulationController,
      /MissingPopulationController is market-scoped and has no @RoutePopulation/,
    ],
    [
      MethodLevelPopulationController,
      /MethodLevelPopulationController\.write carries @RoutePopulation/,
    ],
    [
      SessionWithoutPopulationController,
      /SessionWithoutPopulationController uses @ReadsSession without/,
    ],
    [
      ExemptUnsafeController,
      /ExemptUnsafeController\.write has an unsafe method on a market-exempt/,
    ],
  ])('refuses to boot with %p', async (controller, message) => {
    const booting = createTestApp({ controllers: [controller] });

    await expect(booting).rejects.toThrow(RoutePopulationError);
    await expect(createTestApp({ controllers: [controller] })).rejects.toThrow(message);
  });

  describe('the application', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      ({ app } = await createTestApp());
    });
    afterAll(async () => {
      await app.close();
    });

    it('boots, and every market-scoped controller declares its population', () => {
      const controllers = [...app.get(ModulesContainer).values()].flatMap((moduleRef) =>
        [...moduleRef.controllers.values()].map((wrapper) => wrapper.metatype as object),
      );

      for (const controller of controllers.filter((c) => !isMarketContextExempt(c))) {
        expect(routePopulationOf(controller)).toBeDefined();
      }
      expect(routePopulationOf(CourierSessionController)).toBe('courier');
      expect(routePopulationOf(AdminSessionController)).toBe('admin');
      expect(routePopulationOf(AdminMerchantsController)).toBe('admin');
      expect(routePopulationOf(MerchantDeliveryController)).toBe('merchant');
      expect(routePopulationOf(CourierDeliveryController)).toBe('courier');
      expect(routePopulationOf(AdminDeliveryController)).toBe('admin');
    });
  });
});

describe.each(TEST_MARKETS)('unsafe requests to the real routes in %s (HF14)', (code) => {
  let app: NestExpressApplication;
  let panelApp: NestExpressApplication;
  const signIn = (target: NestExpressApplication, headers: Record<string, string>) =>
    request(target.getHttpServer())
      .post('/identity/admin/sign-in')
      .set({ 'x-market-id': code, ...headers })
      .send({});

  beforeAll(async () => {
    ({ app } = await createTestApp({ override: (builder) => fakes.override(builder) }));
    ({ app: panelApp } = await createTestApp({
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));
  });
  afterAll(async () => {
    await app.close();
    await panelApp.close();
  });
  beforeEach(() => fakes.reset());

  const own = () => panelHeaders(code);

  it.each([
    ['neither header', () => ({})],
    ['no Origin', () => ({ 'sec-fetch-site': 'same-origin' })],
    ['no Sec-Fetch-Site', () => ({ origin: own().origin })],
  ])('refuses an admin sign-in with %s', async (_case, headers) => {
    for (const target of [app, panelApp]) {
      const response = await signIn(target, headers()).expect(403);

      expect(response.body).toEqual({ statusCode: 403, code: 'request.csrf' });
    }
  });

  it('refuses an admin sign-in from another site, the courier app included', async () => {
    const response = await signIn(panelApp, {
      origin: 'https://courier.example.com',
      'sec-fetch-site': 'cross-site',
    }).expect(403);

    expect(response.body).toEqual({ statusCode: 403, code: 'request.csrf' });
  });

  it("accepts the dispatch panel's own origin once the list holds it", async () => {
    const response = await signIn(panelApp, own());

    expect(response.status).toBe(400);
    expect((response.body as { code?: string }).code).not.toBe('request.csrf');
  });

  it('applies the checked-in list: empty in AU (fail closed), the panel host in ZZ', async () => {
    const response = await signIn(app, own());

    if (code === 'AU') {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ statusCode: 403, code: 'request.csrf' });
    } else {
      expect(response.status).toBe(400);
    }
  });

  it('accepts a courier sign-in without origin headers (a bearer app, no cookie)', async () => {
    const response = await request(app.getHttpServer())
      .post('/identity/courier/sign-in')
      .set({ 'x-market-id': code })
      .send({});

    expect(response.status).toBe(400);
  });
});
