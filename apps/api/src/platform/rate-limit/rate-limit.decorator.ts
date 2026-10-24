import { Reflector } from '@nestjs/core';

/**
 * The limit classes of the generic per-origin rate limiter (identity design 6.8), each with its
 * own counter per origin and its own per-minute limit in the Market's `requestLimits`:
 *
 * - `anonymous-identity`: anonymous `identity` routes (sign-up, sign-in, reset requests), the
 *   ones that hash a password or send a mail. 20 a minute for AU.
 * - `default`: every other market-scoped route. 300 a minute for AU.
 *
 * A new class also needs a migration that widens `rate_limit_counters_key_check`
 * (docs/design/data/platform.md section 12), or its requests fail closed with 503.
 */
export const RATE_LIMIT_CLASSES = ['anonymous-identity', 'default'] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/** The metadata of {@link RateLimit}; read only by the rate-limit guard. */
export const RATE_LIMIT_CLASS = Reflector.createDecorator<RateLimitClass>();

/**
 * Puts a controller, or one of its routes, in a limit class of the generic per-origin rate
 * limiter. A route without it is in `default`; a route's own class wins over its controller's.
 * It can only choose between the configured limits, never switch the limiter off.
 */
export function RateLimit(limitClass: RateLimitClass): ClassDecorator & MethodDecorator {
  return RATE_LIMIT_CLASS(limitClass);
}
