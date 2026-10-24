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

// platform-foundations 5.2 rules 1 and 4; identity design 6.2 to 6.4 (slice 2): the actor and
// the CallContext of a request, never defaulted; the session cookie, the CSRF token and the
// origin checks, per route population (Ali's ruling of 2026-10-08 on per-population
// `allowedOrigins`; Hassan's review).

/** One controller per population: a route that reads no session and one that does. */
@RoutePopulation('customer')
@Controller('customer')
class CustomerController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

@RoutePopulation('seller')
@Controller('seller')
class SellerController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

@RoutePopulation('admin')
@Controller('admin')
class AdminController {
  anonymousRoute(this: void): void {}
  @ReadsSession()
  sessionRoute(this: void): void {}
}

const CONTROLLER_OF: Readonly<Record<Population, typeof CustomerController>> = {
  customer: CustomerController,
  seller: SellerController,
  admin: AdminController,
};

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
  @(RoutePopulation('seller') as unknown as MethodDecorator)
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
  controller: { prototype: object } = CustomerController,
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
    sellerId: population === 'seller' ? id('01990000-0000-7000-8000-00000000b001') : null,
  });

class FakeAuthenticator implements Authenticator {
  readonly calls: SessionCredential[] = [];
  answer: Population | 'rejected' | 'throws' | AuthenticatedActor = 'customer';
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

/** The checked-in configuration: AU's three lists are empty until D2. */
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
/**
 * The same, with an empty admin or seller list filled with that population's link-page origin
 * (the value D2 is expected to set). Built here, in memory: no file under `src/` imports the
 * test-only overlay of `test/support` (Ali, PR #179).
 */
const panelMarkets = new MarketRegistry(
  new Map(
    TEST_MARKET_IDS.map((marketId) => {
      const config = markets.get(marketId);
      const filled = (population: 'admin' | 'seller'): readonly string[] => {
        const list = config.allowedOrigins[population];
        if (list.length > 0) return list;
        const pages = Object.values<string>(config.identity.links.targets[population] ?? {});
        return [...new Set(pages.map((page) => new URL(page).origin))];
      };
      const allowedOrigins = {
        ...config.allowedOrigins,
        admin: filled('admin'),
        seller: filled('seller'),
      };
      return [marketId, { ...config, allowedOrigins } as typeof config] as const;
    }),
  ),
);

describe.each(TEST_MARKETS)('the actor and CallContext of a request in %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const cookieName = `__Host-session-customer-${code}`;
  const cookieOf = (population: Population) => `__Host-session-${population}-${code}=${TOKEN}`;
  /** The origin of each population's link pages in this Market (its panel or storefront). */
  const originOf = (population: Population): string => {
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
      population: 'customer',
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

  it("attaches the Market's anonymous actor on a route that reads no session", async () => {
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(actorOf(req).marketId).toBe(market.marketId);
    expect(authenticator.calls).toEqual([]);
  });

  it('attaches the anonymous actor on a session route without the cookie', async () => {
    const req = request({ headers: { cookie: 'other=1' } });

    await expect(guard.canActivate(httpContext(req, 'sessionRoute'))).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  it("authenticates the population's cookie of the request's Market and records the CSRF token", async () => {
    const req = request({ headers: { cookie: `a=b; ${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'sessionRoute'))).resolves.toBe(true);

    expect(authenticator.calls).toEqual([{ token: TOKEN, transport: 'cookie' }]);
    expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population: 'customer' });
    expect(sessionCsrfTokenOf(req)).toBe(csrfTokenFor(TOKEN));
  });

  it.each(POPULATIONS)(
    "reads the %s session through the class's population on a @ReadsSession route",
    async (population) => {
      authenticator.answer = population;
      const req = request({ headers: { cookie: cookieOf(population) } });

      await expect(
        guard.canActivate(httpContext(req, 'sessionRoute', CONTROLLER_OF[population])),
      ).resolves.toBe(true);

      expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population });
    },
  );

  it("ignores another Market's or population's cookie", async () => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const req = request({
      headers: {
        cookie: `__Host-session-customer-${other}=${TOKEN}; __Host-session-admin-${code}=${TOKEN}`,
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
        guard.canActivate(httpContext(req, 'sessionRoute', CustomerController, 'http', response)),
      ),
    ).resolves.toEqual({ status: 401, body: { statusCode: 401, code: 'session.invalid' } });
    expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${cookieName}=; Max-Age=0;`));
    expect(authenticator.calls).toEqual([]);
  });

  it('refuses any Authorization header with session.invalid (HF14), also on an anonymous route', async () => {
    for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
      const req = request({ headers: { authorization: `Bearer ${TOKEN}` } });

      await expect(refusal(guard.canActivate(httpContext(req, handler)))).resolves.toMatchObject({
        status: 401,
        body: { code: 'session.invalid' },
      });
    }
  });

  it.each(POPULATIONS)(
    'clears the %s cookie only on a route that reads a session (Hassan, Low 3)',
    async (population) => {
      for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
        const response = new FakeResponse();
        const req = request({ headers: { authorization: `Bearer ${TOKEN}` } });

        await refusal(
          guard.canActivate(httpContext(req, handler, CONTROLLER_OF[population], 'http', response)),
        );

        if (handler === 'sessionRoute') {
          expect(response.headers.get('Set-Cookie')).toMatch(
            new RegExp(`^__Host-session-${population}-${code}=; Max-Age=0;`),
          );
        } else {
          expect(response.headers.has('Set-Cookie')).toBe(false);
        }
      }
    },
  );

  it('answers session.invalid and clears the cookie when the Authenticator rejects', async () => {
    authenticator.answer = 'rejected';
    const response = new FakeResponse();
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(
      refusal(
        guard.canActivate(httpContext(req, 'sessionRoute', CustomerController, 'http', response)),
      ),
    ).resolves.toMatchObject({ status: 401, body: { code: 'session.invalid' } });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(() => actorOf(req)).toThrow(MissingActorError);
  });

  it('fails closed with access.unavailable when the Authenticator throws', async () => {
    authenticator.answer = 'throws';
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(refusal(guard.canActivate(httpContext(req, 'sessionRoute')))).resolves.toEqual({
      status: 503,
      body: { statusCode: 503, code: 'access.unavailable' },
    });
  });

  it('refuses an actor of another population than the route', async () => {
    authenticator.answer = 'admin';
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(
      refusal(guard.canActivate(httpContext(req, 'sessionRoute'))),
    ).resolves.toMatchObject({
      status: 401,
      body: { code: 'session.invalid' },
    });
  });

  it('a route without a population reads no session, even with a cookie (safe method)', async () => {
    const req = request({ headers: { cookie: cookieOf('customer') } });

    await expect(
      guard.canActivate(httpContext(req, 'sessionRoute', NoPopulationController)),
    ).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  describe('unsafe methods (identity design 6.4)', () => {
    it('needs the CSRF token of the session, checked before the Authenticator runs', async () => {
      for (const header of [undefined, 'wrong', csrfTokenFor(`ms1_${'B'.repeat(43)}`)]) {
        const req = request({
          method: 'POST',
          headers: { cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': header },
        });

        await expect(refusal(guard.canActivate(httpContext(req, 'sessionRoute')))).resolves.toEqual(
          CSRF_REFUSAL,
        );
      }
      expect(authenticator.calls).toEqual([]);
    });

    it('accepts the right CSRF token', async () => {
      const req = request({
        method: 'DELETE',
        headers: { cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': csrfTokenFor(TOKEN) },
      });

      await expect(guard.canActivate(httpContext(req, 'sessionRoute'))).resolves.toBe(true);
    });

    it.each(POPULATIONS)(
      'refuses Sec-Fetch-Site other than same-origin on a %s route, with or without a session (HF14)',
      async (population) => {
        for (const site of ['cross-site', 'same-site', 'none']) {
          for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
            const req = request({
              method: 'POST',
              headers: {
                'sec-fetch-site': site,
                origin: originOf(population),
                cookie: cookieOf(population),
                'x-csrf-token': csrfTokenFor(TOKEN),
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

    it('refuses an Origin that is not on the customer list, and accepts one that is', async () => {
      const allowed = markets.get(market.marketId).allowedOrigins.customer;
      const refused = request({
        method: 'POST',
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      });

      await expect(
        refusal(guard.canActivate(httpContext(refused, 'anonymousRoute'))),
      ).resolves.toEqual(CSRF_REFUSAL);
      for (const origin of allowed) {
        const req = request({
          method: 'POST',
          headers: { origin, 'sec-fetch-site': 'same-origin' },
        });
        await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);
      }
    });

    it('passes a customer request with neither origin header (a non-browser client)', async () => {
      expect(ORIGIN_HEADERS_REQUIRED.customer).toBe(false);
      const req = request({ method: 'POST' });

      await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);
    });

    describe.each(['admin', 'seller'] as const)(
      'a %s route (BFF-only, Ali ruling 3)',
      (population) => {
        const controller = CONTROLLER_OF[population];
        const own = () => ({ origin: originOf(population), 'sec-fetch-site': 'same-origin' });

        it.each([
          ['no Origin', { 'sec-fetch-site': 'same-origin' }],
          ['no Sec-Fetch-Site', 'origin-only'],
          ['neither header', {}],
        ] as const)(
          'refuses a POST with %s, with and without a session (Hassan)',
          async (_case, given) => {
            expect(ORIGIN_HEADERS_REQUIRED[population]).toBe(true);
            const headers = given === 'origin-only' ? { origin: originOf(population) } : given;
            for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
              for (const session of [false, true]) {
                authenticator.answer = population;
                const req = request({
                  method: 'POST',
                  headers: {
                    ...headers,
                    ...(session
                      ? { cookie: cookieOf(population), 'x-csrf-token': csrfTokenFor(TOKEN) }
                      : {}),
                  },
                });

                await expect(
                  refusal(panelGuard.canActivate(httpContext(req, handler, controller))),
                ).resolves.toEqual(CSRF_REFUSAL);
              }
            }
            expect(authenticator.calls).toEqual([]);
          },
        );

        it('accepts its own panel origin with Sec-Fetch-Site: same-origin, with and without a session', async () => {
          authenticator.answer = population;
          const anonymous = request({ method: 'POST', headers: own() });
          const signedIn = request({
            method: 'POST',
            headers: {
              ...own(),
              cookie: cookieOf(population),
              'x-csrf-token': csrfTokenFor(TOKEN),
            },
          });

          await expect(
            panelGuard.canActivate(httpContext(anonymous, 'anonymousRoute', controller)),
          ).resolves.toBe(true);
          await expect(
            panelGuard.canActivate(httpContext(signedIn, 'sessionRoute', controller)),
          ).resolves.toBe(true);
          expect(actorOf(signedIn)).toMatchObject({ kind: 'authenticated', population });
        });

        it("refuses another population's origin, with and without a session (no Login as Seller exception)", async () => {
          for (const other of POPULATIONS.filter((p) => p !== population)) {
            for (const handler of ['anonymousRoute', 'sessionRoute'] as const) {
              authenticator.answer = population;
              const req = request({
                method: 'POST',
                headers: {
                  origin: originOf(other),
                  'sec-fetch-site': 'same-origin',
                  cookie: cookieOf(population),
                  'x-csrf-token': csrfTokenFor(TOKEN),
                },
              });

              await expect(
                refusal(panelGuard.canActivate(httpContext(req, handler, controller))),
              ).resolves.toEqual(CSRF_REFUSAL);
            }
          }
          expect(authenticator.calls).toEqual([]);
        });

        it('logs the refusal with the route population and the reason', async () => {
          const req = request({ method: 'POST' });

          await refusal(panelGuard.canActivate(httpContext(req, 'anonymousRoute', controller)));

          expect(warnings).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'request.csrf', reason: 'origin', population }),
          );
        });

        it('is refused with the checked-in configuration while its list is empty (AU until D2)', async () => {
          const req = request({ method: 'POST', headers: own() });
          const outcome = guard.canActivate(httpContext(req, 'anonymousRoute', controller));

          if (markets.get(market.marketId).allowedOrigins[population].length === 0) {
            await expect(refusal(outcome)).resolves.toEqual(CSRF_REFUSAL);
          } else {
            await expect(outcome).resolves.toBe(true);
          }
        });
      },
    );

    it('a customer route refuses the admin and seller panel origins', async () => {
      for (const other of ['admin', 'seller'] as const) {
        const req = request({
          method: 'POST',
          headers: { origin: originOf(other), 'sec-fetch-site': 'same-origin' },
        });

        await expect(
          refusal(panelGuard.canActivate(httpContext(req, 'anonymousRoute'))),
        ).resolves.toEqual(CSRF_REFUSAL);
      }
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
                { ...config, allowedOrigins: { admin: [], seller: [], customer: [] } },
              ] as const;
            }),
          ),
        );
        const emptyGuard = new ActorGuard(new Reflector(), empty, authenticator);
        const req = request({
          method: 'POST',
          headers: { origin: originOf(population), 'sec-fetch-site': 'same-origin' },
        });

        await expect(
          refusal(
            emptyGuard.canActivate(httpContext(req, 'anonymousRoute', CONTROLLER_OF[population])),
          ),
        ).resolves.toEqual(CSRF_REFUSAL);
      },
    );

    it('refuses an unsafe method on a route with no population (no-route-population)', async () => {
      for (const headers of [
        {},
        { origin: originOf('customer'), 'sec-fetch-site': 'same-origin' },
      ]) {
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
      const req = request({
        method: 'POST',
        headers: { origin: originOf('seller'), 'sec-fetch-site': 'same-origin' },
      });

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
      guard.canActivate(httpContext({}, 'anonymousRoute', CustomerController, 'rpc')),
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
