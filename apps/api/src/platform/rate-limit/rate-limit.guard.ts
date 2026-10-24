import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { MarketRegistry } from '../market-config/market-registry';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import { marketContextOf } from '../market-context/market.decorator';
import { clientAddressFrom } from '../http/client-address';
import { clientOriginOf } from './client-origin';
import { localRateLimitSecret, RateLimitOriginKeys } from './origin-keys';
import { RATE_LIMIT_COUNTERS, type RateLimitCounters } from './rate-limit-counters';
import { RATE_LIMIT_CLASS, type RateLimitClass } from './rate-limit.decorator';

export { RATE_LIMIT_WINDOW_SECONDS } from './rate-limit-counters';

/** The answer to a throttled request (identity design 5.2): 429, a code, never library text. */
export const THROTTLED_CODE = 'request.throttled';
/** The answer when the limiter cannot be evaluated: fail closed (identity design 5.2). */
export const UNAVAILABLE_CODE = 'access.unavailable';

/**
 * The generic per-origin rate limiter (identity design 6.8 and 12.2, ADR-0015 decision 3; the
 * package `rate-limiter-flexible`, owner-approved 2026-10-07). A global guard, second in
 * `GLOBAL_GUARDS`: after `MarketContextGuard`, whose refusals read nothing, and before the
 * actor guard and every controller, so no `identity` code runs for a throttled request
 * (identity design 6.3 step 1).
 *
 * - **Key:** the resolved client address (`platform/http/client-address.ts`, ADR-0037: the
 *   socket's, or the one a BFF proved), as the IPv4 address or the IPv6 /64
 *   ({@link clientOriginOf}). Forwarded headers are never read.
 * - **Counters:** in PostgreSQL ({@link RateLimitCounters}, the package's PostgreSQL store), so
 *   every API instance counts the same window (identity design 13; buyer scale-out item (a)).
 *   One per limit class and origin, not split by Market (PF I11): the limiter is the
 *   cross-Market control. The stored key is the keyed hash of the origin
 *   ({@link RateLimitOriginKeys}), never the address.
 * - **Limits:** the request Market's `requestLimits` (Market configuration); the class comes
 *   from `@RateLimit()`, `default` otherwise. Fixed windows of 60 seconds.
 * - **Answers:** over the limit, 429 `{ statusCode, code: 'request.throttled', details: {
 *   retryAfterSeconds } }` and `Retry-After`; an origin or a counter that cannot be evaluated,
 *   503 `access.unavailable` (fail closed). Never the library's text.
 * - **Exempt:** a controller exempt from the Market (`/health` only) has no Market, so no limit
 *   applies to it; it reaches no module code.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  readonly #logger = new Logger('RateLimitGuard');
  readonly #originKeys: RateLimitOriginKeys;

  constructor(
    private readonly reflector: Reflector,
    private readonly markets: MarketRegistry,
    @Inject(RATE_LIMIT_COUNTERS) private readonly counters: RateLimitCounters,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.#originKeys = new RateLimitOriginKeys(localRateLimitSecret(config));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      throw new Error('RateLimitGuard limits HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage & { id?: unknown }>();
    const limitClass =
      this.reflector.getAllAndOverride(RATE_LIMIT_CLASS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';

    let retryAfterSeconds: number | null;
    try {
      const market = marketContextOf(request);
      const limits = this.markets.get(market.marketId).requestLimits;
      const limit =
        limitClass === 'anonymous-identity'
          ? limits.anonymousIdentityPerMinute
          : limits.defaultPerMinute;
      const origin = clientOriginOf(clientAddressFrom(request));
      if (origin === null) throw new Error('no client origin');
      const counted = await this.counters.consume(limitClass, this.#originKeys.keyOf(origin));
      retryAfterSeconds =
        counted.count > limit ? Math.max(1, Math.ceil(counted.msBeforeNext / 1000)) : null;
    } catch {
      // Fail closed: nothing behind the limiter runs when it cannot decide.
      this.log('rate-limit.unavailable', request, limitClass);
      throw new HttpException({ statusCode: 503, code: UNAVAILABLE_CODE }, 503);
    }

    if (retryAfterSeconds === null) return true;
    this.log(THROTTLED_CODE, request, limitClass);
    http.getResponse<ServerResponse>().setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      { statusCode: 429, code: THROTTLED_CODE, details: { retryAfterSeconds } },
      429,
    );
  }

  /** The limit class and the correlation id; never the address (personal data) or a count. */
  private log(msg: string, request: { id?: unknown }, limitClass: RateLimitClass): void {
    this.#logger.warn({ msg, limitClass, correlationId: request.id ?? null });
  }
}
