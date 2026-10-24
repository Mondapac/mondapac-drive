import type { ExecutionContext } from '@nestjs/common';
import { BadRequestException, Controller, Get } from '@nestjs/common';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { HealthController } from '../health/health.controller';
import { MarketFromPath, takesMarketFromPath } from '../http/market-from-path.decorator';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from './market-context.factory';
import * as guardFile from './market-context.guard';
import { isMarketContextExempt, MarketContextGuard } from './market-context.guard';
import { marketContextOf } from './market.decorator';
import { NoMarketContext } from './no-market-context.decorator';
import { PLATFORM_TENANT_ID } from './tenant';

@Controller('scoped')
class ScopedController {
  @Get()
  list(): string[] {
    return [];
  }
}

@NoMarketContext()
@Controller('exempt')
class ExemptController {
  @Get()
  ping(): string {
    return 'pong';
  }
}

@Controller('inherits')
class InheritingController extends ExemptController {}

@Controller('method-level')
class MethodLevelController {
  @Get()
  ping(): string {
    return 'pong';
  }
}
// The decorator is typed as a class decorator; forced onto a method it must exempt nothing.
(NoMarketContext() as unknown as MethodDecorator)(
  MethodLevelController.prototype,
  'ping',
  Object.getOwnPropertyDescriptor(MethodLevelController.prototype, 'ping')!,
);

function httpContext(
  controller: object,
  handler: () => unknown = () => undefined,
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function rejectionOf(guard: MarketContextGuard, context: ExecutionContext): unknown {
  try {
    guard.canActivate(context);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error('expected the guard to refuse the request');
}

describe('isMarketContextExempt', () => {
  it('exempts the health controller', () => {
    expect(isMarketContextExempt(HealthController)).toBe(true);
  });

  it('exempts a controller class that carries the decorator', () => {
    expect(isMarketContextExempt(ExemptController)).toBe(true);
  });

  it('exempts nothing else: a controller is market-scoped by default', () => {
    expect(isMarketContextExempt(ScopedController)).toBe(false);
  });

  it('reads the class itself: a subclass of an exempt controller is not exempt', () => {
    expect(isMarketContextExempt(InheritingController)).toBe(false);
  });

  it('reads the class only: the decorator on a method exempts nothing', () => {
    expect(isMarketContextExempt(MethodLevelController)).toBe(false);
  });
});

describe('MarketContextGuard', () => {
  const guard = new MarketContextGuard(
    new MarketContextFactory(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
      PLATFORM_TENANT_ID,
    ),
  );

  it('lets an exempt controller through without a header', () => {
    expect(guard.canActivate(httpContext(ExemptController))).toBe(true);
  });

  it.each([InheritingController, MethodLevelController, ScopedController])(
    'asks %p for the header',
    (controller) => {
      expect(rejectionOf(guard, httpContext(controller))).toEqual({
        statusCode: 400,
        code: 'market.header-missing',
      });
    },
  );

  it('ignores the decorator on the handler that runs: a method-level use exempts nothing', () => {
    // The very function that carries the method-level metadata, as Nest passes it.
    const ping = Object.getOwnPropertyDescriptor(MethodLevelController.prototype, 'ping')!
      .value as () => unknown;
    const context = httpContext(MethodLevelController, ping);

    expect(rejectionOf(guard, context)).toEqual({
      statusCode: 400,
      code: 'market.header-missing',
    });
  });

  it('refuses an execution context that is not HTTP', () => {
    const rpc = { ...httpContext(ExemptController), getType: () => 'rpc' };

    expect(() => guard.canActivate(rpc as unknown as ExecutionContext)).toThrow(/HTTP/);
  });
});

describe('the guard file', () => {
  // Decision 3: it exports the guard and the predicate only, never the decorator or its key.
  it('exports MarketContextGuard and isMarketContextExempt, and nothing else', () => {
    expect(Object.keys(guardFile).sort()).toEqual(['MarketContextGuard', 'isMarketContextExempt']);
  });
});

@MarketFromPath()
@Controller('by-path/:market')
class PathMarketController {
  @Get()
  ping(): string {
    return 'pong';
  }
}

@Controller('inherits-path/:market')
class InheritsPathController extends PathMarketController {}

const AU = 'AU';
const ZZ = 'ZZ';

describe('MarketContextGuard with @MarketFromPath()', () => {
  const guard = new MarketContextGuard(
    new MarketContextFactory(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
      PLATFORM_TENANT_ID,
    ),
  );
  const pathContext = (
    controller: object,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const request = { headers, params };
    const context = {
      getType: () => 'http',
      getClass: () => controller,
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  };

  it('takes the Market from :market and ignores x-market-id', () => {
    const { context, request } = pathContext(
      PathMarketController,
      { market: AU },
      { 'x-market-id': ZZ },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(marketContextOf(request as never).marketId).toBe(AU);
  });

  it.each([
    [{}, 'market.header-missing'],
    [{ market: 'au' }, 'market.header-invalid'],
    [{ market: ['AU'] }, 'market.header-invalid'],
    [{ market: 'QQ' }, 'market.not-hosted'],
  ])('refuses the path value %p with %s, whatever the header says', (params, code) => {
    const { context } = pathContext(PathMarketController, params, {
      'x-market-id': AU,
    });

    expect(rejectionOf(guard, context)).toEqual({ statusCode: 400, code });
  });

  it('reads the class itself: a subclass and every other controller still need the header', () => {
    for (const controller of [InheritsPathController, ScopedController]) {
      const { context } = pathContext(controller, { market: AU });
      expect(rejectionOf(guard, context)).toEqual({
        statusCode: 400,
        code: 'market.header-missing',
      });
    }
    expect(takesMarketFromPath(PathMarketController)).toBe(true);
    expect(takesMarketFromPath(InheritsPathController)).toBe(false);
  });
});
