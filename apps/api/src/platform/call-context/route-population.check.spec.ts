import {
  All,
  Controller,
  Delete,
  Get,
  Head,
  Options,
  Patch,
  Post,
  Put,
  Search,
} from '@nestjs/common';
import { NoMarketContext } from '../market-context/no-market-context.decorator';
import { routePopulationProblems } from './route-population.check';
import { ReadsSession, RoutePopulation } from './route-population.decorator';

// The start-up check of identity design 6.4 (Ali's ruling and Hassan's review of 2026-10-08).

@RoutePopulation('admin')
@Controller('good')
class GoodController {
  @Post('sign-in')
  signIn(): void {}
  @Get('session')
  @ReadsSession()
  session(): void {}
}

@RoutePopulation('seller')
@ReadsSession()
@Controller('class-session')
class ClassSessionController {
  @Put()
  save(): void {}
}

@Controller('missing')
class MissingController {
  @Get()
  read(): void {}
}

@Controller('session-without-population')
class SessionWithoutPopulationController {
  @Post()
  @ReadsSession()
  write(): void {}
}

@RoutePopulation('customer')
@Controller('method-level')
class MethodLevelController {
  @Post()
  @(RoutePopulation('admin') as unknown as MethodDecorator)
  write(): void {}
}

@NoMarketContext()
@Controller('exempt-safe')
class ExemptSafeController {
  @Get()
  get(): void {}
  @Head()
  head(): void {}
  @Options()
  options(): void {}
  /** Not a route: no path metadata. */
  helper(): void {}
}

function exemptWith(name: string, decorator: MethodDecorator) {
  @NoMarketContext()
  @Controller(name)
  class Exempt {
    @decorator
    route(): void {}
  }
  Object.defineProperty(Exempt, 'name', { value: name });
  return Exempt;
}

describe('routePopulationProblems', () => {
  it('accepts class-level populations and @ReadsSession on a class or a method', () => {
    expect(
      routePopulationProblems([GoodController, ClassSessionController, ExemptSafeController]),
    ).toEqual([]);
  });

  it('refuses a market-scoped controller without a population', () => {
    expect(routePopulationProblems([MissingController])).toEqual([
      'MissingController is market-scoped and has no @RoutePopulation on the class',
    ]);
  });

  it('refuses @ReadsSession without a @RoutePopulation', () => {
    expect(routePopulationProblems([SessionWithoutPopulationController])).toEqual([
      'SessionWithoutPopulationController uses @ReadsSession without a @RoutePopulation on the class',
    ]);
  });

  it('refuses @RoutePopulation on a method', () => {
    expect(routePopulationProblems([MethodLevelController])).toEqual([
      'MethodLevelController.write carries @RoutePopulation; it belongs on the class only',
    ]);
  });

  it.each([
    ['Post', Post()],
    ['Put', Put()],
    ['Patch', Patch()],
    ['Delete', Delete()],
    ['All', All()],
    ['Search', Search()],
  ])('refuses an unsafe %s route on a market-exempt controller', (method, decorator) => {
    const controller = exemptWith(`Exempt${method}`, decorator);

    expect(routePopulationProblems([controller])).toEqual([
      `Exempt${method}.route has an unsafe method on a market-exempt controller (no origin check)`,
    ]);
  });

  it('reports every problem of every controller', () => {
    expect(
      routePopulationProblems([MissingController, MethodLevelController, GoodController]),
    ).toHaveLength(2);
  });
});
