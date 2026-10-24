import { SetMetadata } from '@nestjs/common';
import type { Population } from '@mondapac-drive/shared-kernel';

/** The metadata key of {@link RoutePopulation}; read only through {@link routePopulationOf}. */
export const ROUTE_POPULATION = 'mondapac:route-population';

/** The metadata key of {@link ReadsSession}. */
export const READS_SESSION = 'mondapac:reads-session';

/**
 * The population a controller serves (identity design 6.4; Ali's ruling of 2026-10-08): the
 * actor guard checks an unsafe request's `Origin` against `allowedOrigins[population]` and, on a
 * route marked {@link ReadsSession}, reads only the session cookie of this population. Required
 * on every market-scoped controller, on the class only: the start-up check
 * (`route-population.check.ts`) refuses to boot when a market-scoped controller lacks it or a
 * method carries it, so one route can never use another population's allow-list.
 */
export function RoutePopulation(population: Population): ClassDecorator {
  return SetMetadata(ROUTE_POPULATION, population);
}

/**
 * Marks a controller, or one of its routes, as reading the session of the controller's
 * population (the class's {@link RoutePopulation}; it takes no population of its own, so the two
 * can never differ). A route without it reads no session: its actor is the Market's anonymous
 * actor, whatever cookie the request carries (sign-in, sign-up and reset requests). Using it
 * without a `@RoutePopulation` on the class fails the start-up check.
 */
export function ReadsSession(): ClassDecorator & MethodDecorator {
  return SetMetadata(READS_SESSION, true);
}

/** The population a controller class declares itself (never a parent's or a method's). */
export function routePopulationOf(controller: object): Population | undefined {
  return Reflect.getOwnMetadata(ROUTE_POPULATION, controller) as Population | undefined;
}
