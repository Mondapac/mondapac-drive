import { Controller, HttpException, Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { err, ok, parseId, POPULATIONS } from '@mondapac-drive/shared-kernel';
import type { AuthenticatedActor, Id, MarketContext, Population } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
  TEST_CORRELATION_ID,
} from '@mondapac-drive/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../test/support/test-config';
import type { Authenticator, SessionCredential } from '../authz/authenticator';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { attachMarketContext } from '../market-context/attached-market-context';
import { MissingMarketContextError } from '../market-context/market.decorator';
import { NoMarketContext } from '../market-context/no-market-context.decorator';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import { ActorGuard } from './actor.guard';
import { callContextOf, MissingCorrelationIdError } from './call-context.decorator';
import { csrfTokenFor, ORIGIN_HEADERS_REQUIRED } from './csrf';
import { actorOf, attachActor, MissingActorError } from './request-actor';
import { ReadsSession, RoutePopulation } from './route-population.decorator';
import { sessionCsrfTokenOf } from './session-csrf-token';

// platform-foundations 5.2 rules 1 and 4; identity design 6.2 to 6.4 (copied from the
// marketplace, slice 2): the actor and the CallContext of a request, never defaulted; per route
// population, its one credential transport (the admin cookie with its CSRF token, the courier's
// bearer token, the merchant's API key) and the origin checks.

/** One controller per population: a route that reads no session and one that does. */
@RoutePopulation('admin')
@Controller('admin')
class AdminController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

@RoutePopulation('merchant')
@Controller('merchant')
class MerchantController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

@RoutePopulation('courier')
@Controller('courier')
class CourierController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

const CONTROLLER_OF: Readonly<Record<Population, typeof AdminController>> = {
  admin: AdminController,
  merchant: MerchantController,
  courier: CourierController,
};

/** The populations whose credential is an `Authorization: Bearer` header. */
const BEARER_POPULATIONS = ['merchant', 'courier'] as const;

/** A market-scoped controller without a population (the start-up check refuses it). */
@Controller('no-population')
class NoPopulationController {
  anonymousRoute(this: void): void {}
  sessionRoute(this: void): void {}
}

/** A method-level population, forced past the type: the guard reads the class's only. */
@RoutePopulation('admin')
@Controller('method-level')
class MethodLevelController {
  @(RoutePopulation('courier') as unknown as MethodDecorator)
  anonymousRoute(this: void): void {}
  sessionRoute(this: void): void {}
}

@NoMarketContext()
@Controller('exempt')
class ExemptController {}

type Handler = 'anonymousRoute' | 'sessionRoute';

const TOKEN = `ms1_${'A'.repeat(43)}`;
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

interface FakeRequest {
  id?: unknown;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

class FakeResponse {
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function httpContext(
  request: object,
  handler: Handler | null,
  controller: { prototype: object } = AdminController,
  type = 'http',
  response: FakeResponse = new FakeResponse(),
): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => controller,
    getHandler: () =>
      handler === null
        ? () => undefined
        : (controller.prototype as Record<Handler, unknown>)[handler],
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const actorOfPopulation = (market: MarketContext, population: Population): AuthenticatedActor =>
  testAuthenticatedActor(market, {
    population,
    accountId: id('01990000-0000-7000-8000-000000000001'),
    sessionId: id('01990000-0000-7000-8000-00000000a001'),
    merchantId: population === 'merchant' ? id('01990000-0000-7000-8000-00000000b001') : null,
  });

class FakeAuthenticator implements Authenticator {
  readonly calls: SessionCredential[] = [];
  answer: Population | 'rejected' | 'throws' | AuthenticatedActor = 'admin';
  constructor(private readonly market: MarketContext) {}

  authenticate(_market: MarketContext, credential: SessionCredential) {
    this.calls.push(credential);
    if (this.answer === 'throws') return Promise.reject(new Error('database down'));
    if (this.answer === 'rejected')
      return Promise.resolve(err({ code: 'credential.rejected' as const }));
    return Promise.resolve(
      ok(
        typeof this.answer === 'string' ? actorOfPopulation(this.market, this.answer) : this.answer,
      ),
    );
  }
}

/** The checked-in configuration: AU's three lists are empty until the panel is hosted. */
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
/**
 * The same, with an empty admin list filled with the admin link pages' origin (the value the
 * panel's hosting is expected to set). Built here, in memory: no file under `src/` imports the
 * test-only overlay of `test/support`.
 */
const panelMarkets = new MarketRegistry(
  new Map(
    TEST_MARKET_IDS.map((marketId) => {
      const config = markets.get(marketId);
      const list = config.allowedOrigins.admin;
      const pages = Object.values<string>(config.identity.links.targets.admin ?? {});
      const allowedOrigins = {
        ...config.allowedOrigins,
        admin: list.length > 0 ? list : [...new Set(pages.map((page) => new URL(page).origin))],
      };
      return [marketId, { ...config, allowedOrigins } as typeof config] as const;
    }),
  ),
);

describe.each(TEST_MARKETS)('the actor and CallContext of a request in %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const cookieName = `__Host-session-admin-${code}`;
  const cookieOf = (population: Population) => `__Host-session-${population}-${code}=${TOKEN}`;
  const BEARER = `Bearer ${TOKEN}`;
  /** The origin of a population's link pages in this Market (the admin panel, the courier site). */
  const originOf = (population: 'admin' | 'courier'): string => {
    const targets = markets.get(market.marketId).identity.links.targets;
    const pages = Object.values<string>(targets[population] ?? {});
    return new URL(pages[0]!).origin;
  };
  let authenticator: FakeAuthenticator;
  let guard: ActorGuard;
  let panelGuard: ActorGuard;

  let warnings: jest.SpyInstance;

  beforeEach(() => {
    authenticator = new FakeAuthenticator(market);
    guard = new ActorGuard(new Reflector(), markets, authenticator);
    panelGuard = new ActorGuard(new Reflector(), panelMarkets, authenticator);
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  it('logs a refusal with its reason and the correlation id, never the token', async () => {
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}; ${cookieName}=x` } });

    await refusal(guard.canActivate(httpContext(req, 'sessionRoute')));

    expect(warnings).toHaveBeenCalledWith({
      msg: 'actor.refused',
      code: 'session.invalid',
      reason: 'cookie-refused',
      population: 'admin',
      marketId: code,
      correlationId: TEST_CORRELATION_ID,
    });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(TOKEN);
  });

  function request(fields: Partial<FakeRequest> = {}): FakeRequest {
    const built: FakeRequest = { id: TEST_CORRELATION_ID, method: 'GET', headers: {}, ...fields };
    attachMarketContext(built, market);
    return built;
  }

  async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpException)
        return { status: error.getStatus(), body: error.getResponse() };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  const CSRF_REFUSAL = { status: 403, body: { statusCode: 403, code: 'request.csrf' } };
  const INVALID = { status: 401, body: { statusCode: 401, code: 'session.invalid' } };

  it("attaches the Market's anonymous actor on a route that reads no session", async () => {
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(actorOf(req).marketId).toBe(market.marketId);
    expect(authenticator.calls).toEqual([]);
  });

  it.each(POPULATIONS)(
    'attaches the anonymous actor on a %s session route without a credential',
    async (population) => {
      const req = request({ headers: { cookie: 'other=1' } });

      await expect(
        guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population])),
      ).resolves.toBe(true);

      expect(actorOf(req).kind).toBe('anonymous');
      expect(authenticator.calls).toEqual([]);
    },
  );

  it("authenticates the admin cookie of the request's Market and records the CSRF token", async () => {
    const req = request({ headers: { cookie: `a=b; ${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'sessionRoute'))).resolves.toBe(true);

    expect(authenticator.calls).toEqual([{ token: TOKEN, transport: 'cookie' }]);
    expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population: 'admin' });
    expect(sessionCsrfTokenOf(req)).toBe(csrfTokenFor(TOKEN));
  });

  it.each([
    ['merchant', 'api-key'],
    ['courier', 'bearer'],
  ] as const)(
    'authenticates the %s credential from Authorization: Bearer as transport %s, with no CSRF token',
    async (population, transport) => {
      authenticator.answer = population;
      const req = request({ headers: { authorization: BEARER } });

      await expect(
        guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population])),
      ).resolves.toBe(true);

      expect(authenticator.calls).toEqual([{ token: TOKEN, transport }]);
      expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population });
      expect(sessionCsrfTokenOf(req)).toBeNull();
    },
  );

  it.each(BEARER_POPULATIONS)(
    'never reads a cookie on a %s route, even one named for it',
    async (population) => {
      const req = request({ headers: { cookie: cookieOf(population) } });

      await expect(
        guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population])),
      ).resolves.toBe(true);

      expect(actorOf(req).kind).toBe('anonymous');
      expect(authenticator.calls).toEqual([]);
    },
  );

  it.each(BEARER_POPULATIONS)(
    'refuses a malformed or repeated Authorization header on a %s route, without Set-Cookie',
    async (population) => {
      for (const authorization of [
        `Basic ${TOKEN}`,
        'Bearer short',
        `Bearer ${TOKEN} extra`,
        `bearer ${TOKEN}`,
        `Bearer ${'A'.repeat(301)}`,
        [BEARER, BEARER],
      ]) {
        const response = new FakeResponse();
        const req = request({ headers: { authorization } });

        await expect(
          refusal(
            guard.canActivate(
              httpContext(req, 'sessionRoute', CONTROLLER_OF[population], 'http', response),
            ),
          ),
        ).resolves.toEqual(INVALID);
        expect(response.headers.has('Set-Cookie')).toBe(false);
      }
      expect(authenticator.calls).toEqual([]);
    },
  );

  it("ignores another Market's or population's cookie", async () => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const req = request({
      headers: {
        cookie: `__Host-session-admin-${other}=${TOKEN}; __Host-session-courier-${code}=${TOKEN}`,
      },
    });

    await guard.canActivate(httpContext(req, 'sessionRoute'));

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  it('refuses a repeated cookie name with session.invalid and clears it (HF7)', async () => {
    const response = new FakeResponse();
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}; ${cookieName}=${TOKEN}` } });

    await expect(
      refusal(
        guard.canActivate(httpContext(req, 'sessionRoute', AdminController, 'http', response)),
      ),
    ).resolves.toEqual(INVALID);
    expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${cookieName}=; Max-Age=0;`));
    expect(authenticator.calls).toEqual([]);
  });

  it('refuses an Authorization header on every admin route and on anonymous bearer routes (HF14)', async () => {
    const cases = [
      [AdminController, 'anonymousRoute'],
      [AdminController, 'sessionRoute'],
      [MerchantController, 'anonymousRoute'],
      [CourierController, 'anonymousRoute'],
      [NoPopulationController, 'sessionRoute'],
    ] as const;
    for (const [controller, handler] of cases) {
      const req = request({ headers: { authorization: BEARER } });

      await expect(
        refusal(guard.canActivate(httpContext(req, handler, controller))),
      ).resolves.toEqual(INVALID);
    }
    expect(authenticator.calls).toEqual([]);
  });

  it('clears the admin cookie only on a route that reads a session (Hassan, Low 3)', async () => {
    for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
      const response = new FakeResponse();
      const req = request({ headers: { authorization: BEARER } });

      await refusal(guard.canActivate(httpContext(req, handler, AdminController, 'http', response)));

      if (handler === 'sessionRoute') {
        expect(response.headers.get('Set-Cookie')).toMatch(
          new RegExp(`^__Host-session-admin-${code}=; Max-Age=0;`),
        );
      } else {
        expect(response.headers.has('Set-Cookie')).toBe(false);
      }
    }
  });

  it('answers session.invalid and clears the cookie when the Authenticator rejects', async () => {
    authenticator.answer = 'rejected';
    const response = new FakeResponse();
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(
      refusal(
        guard.canActivate(httpContext(req, 'sessionRoute', AdminController, 'http', response)),
      ),
    ).resolves.toMatchObject({ status: 401, body: { code: 'session.invalid' } });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(() => actorOf(req)).toThrow(MissingActorError);
  });

  it.each(BEARER_POPULATIONS)(
    'answers session.invalid without Set-Cookie when the Authenticator rejects a %s token',
    async (population) => {
      authenticator.answer = 'rejected';
      const response = new FakeResponse();
      const req = request({ headers: { authorization: BEARER } });

      await expect(
        refusal(
          guard.canActivate(
            httpContext(req, 'sessionRoute', CONTROLLER_OF[population], 'http', response),
          ),
        ),
      ).resolves.toEqual(INVALID);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    },
  );

  it('fails closed with access.unavailable when the Authenticator throws', async () => {
    authenticator.answer = 'throws';
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(refusal(guard.canActivate(httpContext(req, 'sessionRoute')))).resolves.toEqual({
      status: 503,
      body: { statusCode: 503, code: 'access.unavailable' },
    });
  });

  it.each(POPULATIONS)(
    'refuses an actor of another population than the %s route',
    async (population) => {
      for (const other of POPULATIONS.filter((p) => p !== population)) {
        authenticator.answer = other;
        const req = request({
          headers:
            population === 'admin' ? { cookie: cookieOf('admin') } : { authorization: BEARER },
        });

        await expect(
          refusal(guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population]))),
        ).resolves.toEqual(INVALID);
      }
    },
  );

  it('a route without a population reads no session, even with a cookie (safe method)', async () => {
    const req = request({ headers: { cookie: cookieOf('admin') } });

    await expect(
      guard.canActivate(httpContext(req, 'sessionRoute', NoPopulationController)),
    ).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  describe('unsafe methods (identity design 6.4)', () => {
    const own = () => ({ origin: originOf('admin'), 'sec-fetch-site': 'same-origin' });

    it("needs the admin session's CSRF token, checked before the Authenticator runs", async () => {
      for (const header of [undefined, 'wrong', csrfTokenFor(`ms1_${'B'.repeat(43)}`)]) {
        const req = request({
          method: 'POST',
          headers: { ...own(), cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': header },
        });

        await expect(
          refusal(panelGuard.canActivate(httpContext(req, 'sessionRoute'))),
        ).resolves.toEqual(CSRF_REFUSAL);
      }
      expect(authenticator.calls).toEqual([]);
    });

    it('accepts the right CSRF token', async () => {
      const req = request({
        method: 'DELETE',
        headers: { ...own(), cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': csrfTokenFor(TOKEN) },
      });

      await expect(panelGuard.canActivate(httpContext(req, 'sessionRoute'))).resolves.toBe(true);
    });

    it.each(BEARER_POPULATIONS)(
      'needs no CSRF token and no origin header for a %s token (not ambient)',
      async (population) => {
        authenticator.answer = population;
        const req = request({ method: 'POST', headers: { authorization: BEARER } });

        await expect(
          guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population])),
        ).resolves.toBe(true);
        expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population });
      },
    );

    it.each(POPULATIONS)(
      'refuses Sec-Fetch-Site other than same-origin on a %s route, with or without a session (HF14)',
      async (population) => {
        for (const site of ['cross-site', 'same-site', 'none']) {
          for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
            const req = request({
              method: 'POST',
              headers: {
                'sec-fetch-site': site,
                ...(population === 'admin'
                  ? {
                      origin: originOf('admin'),
                      cookie: cookieOf('admin'),
                      'x-csrf-token': csrfTokenFor(TOKEN),
                    }
                  : handler === 'sessionRoute'
                    ? { authorization: BEARER }
                    : {}),
              },
            });

            await expect(
              refusal(panelGuard.canActivate(httpContext(req, handler, CONTROLLER_OF[population]))),
            ).resolves.toEqual(CSRF_REFUSAL);
          }
        }
        expect(authenticator.calls).toEqual([]);
      },
    );

    it.each(BEARER_POPULATIONS)(
      'passes a %s request with neither origin header (a server or the app), and refuses any Origin while its list is empty',
      async (population) => {
        expect(ORIGIN_HEADERS_REQUIRED[population]).toBe(false);
        const controller = CONTROLLER_OF[population];
        const plain = request({ method: 'POST' });

        await expect(guard.canActivate(httpContext(plain, 'anonymousRoute', controller))).resolves.toBe(
          true,
        );
        if (markets.get(market.marketId).allowedOrigins[population].length === 0) {
          for (const origin of [originOf('admin'), originOf('courier'), 'https://evil.example']) {
            const req = request({
              method: 'POST',
              headers: { origin, 'sec-fetch-site': 'same-origin' },
            });
            await expect(
              refusal(panelGuard.canActivate(httpContext(req, 'anonymousRoute', controller))),
            ).resolves.toEqual(CSRF_REFUSAL);
          }
        }
      },
    );

    describe('an admin route (BFF-only, Ali ruling 3)', () => {
      it.each([
        ['no Origin', { 'sec-fetch-site': 'same-origin' }],
        ['no Sec-Fetch-Site', 'origin-only'],
        ['neither header', {}],
      ] as const)(
        'refuses a POST with %s, with and without a session (Hassan)',
        async (_case, given) => {
          expect(ORIGIN_HEADERS_REQUIRED.admin).toBe(true);
          const headers = given === 'origin-only' ? { origin: originOf('admin') } : given;
          for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
            for (const session of [false, true]) {
              const req = request({
                method: 'POST',
                headers: {
                  ...headers,
                  ...(session
                    ? { cookie: cookieOf('admin'), 'x-csrf-token': csrfTokenFor(TOKEN) }
                    : {}),
                },
              });

              await expect(
                refusal(panelGuard.canActivate(httpContext(req, handler, AdminController))),
              ).resolves.toEqual(CSRF_REFUSAL);
            }
          }
          expect(authenticator.calls).toEqual([]);
        },
      );

      it('accepts its own panel origin with Sec-Fetch-Site: same-origin, with and without a session', async () => {
        const anonymous = request({ method: 'POST', headers: own() });
        const signedIn = request({
          method: 'POST',
          headers: { ...own(), cookie: cookieOf('admin'), 'x-csrf-token': csrfTokenFor(TOKEN) },
        });

        await expect(
          panelGuard.canActivate(httpContext(anonymous, 'anonymousRoute', AdminController)),
        ).resolves.toBe(true);
        await expect(
          panelGuard.canActivate(httpContext(signedIn, 'sessionRoute', AdminController)),
        ).resolves.toBe(true);
        expect(actorOf(signedIn)).toMatchObject({ kind: 'authenticated', population: 'admin' });
      });

      it("refuses the courier site's origin and any other, with and without a session", async () => {
        for (const origin of [originOf('courier'), 'https://evil.example']) {
          for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
            const req = request({
              method: 'POST',
              headers: {
                origin,
                'sec-fetch-site': 'same-origin',
                cookie: cookieOf('admin'),
                'x-csrf-token': csrfTokenFor(TOKEN),
              },
            });

            await expect(
              refusal(panelGuard.canActivate(httpContext(req, handler, AdminController))),
            ).resolves.toEqual(CSRF_REFUSAL);
          }
        }
        expect(authenticator.calls).toEqual([]);
      });

      it('logs the refusal with the route population and the reason', async () => {
        const req = request({ method: 'POST' });

        await refusal(panelGuard.canActivate(httpContext(req, 'anonymousRoute', AdminController)));

        expect(warnings).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'request.csrf', reason: 'origin', population: 'admin' }),
        );
      });

      it('is refused with the checked-in configuration while its list is empty (AU until the panel is hosted)', async () => {
        const req = request({ method: 'POST', headers: own() });
        const outcome = guard.canActivate(httpContext(req, 'anonymousRoute', AdminController));

        if (markets.get(market.marketId).allowedOrigins.admin.length === 0) {
          await expect(refusal(outcome)).resolves.toEqual(CSRF_REFUSAL);
        } else {
          await expect(outcome).resolves.toBe(true);
        }
      });
    });

    it.each(POPULATIONS)(
      'refuses any Origin on a %s route whose list is empty (fail closed)',
      async (population) => {
        const empty = new MarketRegistry(
          new Map(
            [...TEST_MARKET_IDS].map((marketId) => {
              const config = markets.get(marketId);
              return [
                marketId,
                { ...config, allowedOrigins: { admin: [], merchant: [], courier: [] } },
              ] as const;
            }),
          ),
        );
        const emptyGuard = new ActorGuard(new Reflector(), empty, authenticator);
        const req = request({
          method: 'POST',
          headers: { origin: originOf('admin'), 'sec-fetch-site': 'same-origin' },
        });

        await expect(
          refusal(
            emptyGuard.canActivate(httpContext(req, 'anonymousRoute', CONTROLLER_OF[population])),
          ),
        ).resolves.toEqual(CSRF_REFUSAL);
      },
    );

    it('refuses an unsafe method on a route with no population (no-route-population)', async () => {
      for (const headers of [{}, own()]) {
        const req = request({ method: 'POST', headers });

        await expect(
          refusal(
            panelGuard.canActivate(httpContext(req, 'anonymousRoute', NoPopulationController)),
          ),
        ).resolves.toEqual(CSRF_REFUSAL);
      }
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no-route-population', population: null }),
      );
    });

    it("checks the class's population, never a method's", async () => {
      // The method claims courier (no origin headers needed); the class is admin, which needs them.
      const req = request({ method: 'POST' });

      await expect(
        refusal(panelGuard.canActivate(httpContext(req, 'anonymousRoute', MethodLevelController))),
      ).resolves.toEqual(CSRF_REFUSAL);
    });

    it('does not apply the origin checks to a safe method', async () => {
      for (const population of POPULATIONS) {
        const req = request({
          headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
        });

        await expect(
          guard.canActivate(httpContext(req, 'anonymousRoute', CONTROLLER_OF[population])),
        ).resolves.toBe(true);
      }
    });
  });

  it('throws when the Market guard did not run first', async () => {
    await expect(
      guard.canActivate(httpContext({ method: 'GET', headers: {} }, 'anonymousRoute')),
    ).rejects.toThrow(MissingMarketContextError);
  });

  it('leaves an exempt controller without an actor', async () => {
    const req = { method: 'GET', headers: {} };

    await expect(guard.canActivate(httpContext(req, null, ExemptController))).resolves.toBe(true);
    expect(() => actorOf(req)).toThrow(MissingActorError);
  });

  it('refuses a non-HTTP context', async () => {
    await expect(
      guard.canActivate(httpContext({}, 'anonymousRoute', AdminController, 'rpc')),
    ).rejects.toThrow(/HTTP requests only/);
  });

  it('callContextOf builds the context from the attached Market, actor and request id', async () => {
    const req = request();
    await guard.canActivate(httpContext(req, 'anonymousRoute'));

    const context = callContextOf(req);

    expect(context.market).toBe(market);
    expect(context.actor).toBe(actorOf(req));
    expect(context.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('callContextOf throws without a valid correlation id', async () => {
    for (const correlation of [undefined, '', 'bad id with spaces', 42]) {
      const req = request({ id: correlation });
      await guard.canActivate(httpContext(req, 'anonymousRoute'));

      expect(() => callContextOf(req)).toThrow(MissingCorrelationIdError);
    }
  });

  it('callContextOf throws without an actor; it never defaults', () => {
    const req = request();

    expect(() => callContextOf(req)).toThrow(MissingActorError);
  });

  it('attachActor refuses an actor that was not minted, and a second actor', () => {
    const minted = testCallContext(market, 'anonymous').actor;
    const req = {};

    expect(() => attachActor(req, { ...minted })).toThrow(/not minted/);
    attachActor(req, minted);
    expect(() => attachActor(req, minted)).toThrow(/already has an actor/);
  });
});
