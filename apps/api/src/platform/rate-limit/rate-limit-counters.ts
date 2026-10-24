import type { RateLimitClass } from './rate-limit.decorator';

/** The fixed window of every per-origin limit (identity design 6.8, M11: fixed windows). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The limit classes counted per subject rather than per origin, each with its own fixed window:
 * a module counts them through {@link SubjectRateLimits} and compares the count with its own
 * limit. `assistant-message`: the buyer assistant's messages per guest token, per origin and per
 * customer account (plan section 8: 10-minute windows, the limits are Market settings). A new
 * class also needs a migration that widens `rate_limit_counters_key_check`.
 */
export const SUBJECT_LIMIT_WINDOWS = Object.freeze({ 'assistant-message': 600 } as const);
export type SubjectLimitClass = keyof typeof SUBJECT_LIMIT_WINDOWS;

/** Every class the counters keep: the guard's per-origin classes and the per-subject ones. */
export type CountedClass = RateLimitClass | SubjectLimitClass;

/** The fixed window of a counted class, in seconds. */
export function windowSecondsOf(counted: CountedClass): number {
  return counted in SUBJECT_LIMIT_WINDOWS
    ? SUBJECT_LIMIT_WINDOWS[counted as SubjectLimitClass]
    : RATE_LIMIT_WINDOW_SECONDS;
}

/** One counted request: the window's count so far, this request included, and its time left. */
export interface RateLimitCount {
  readonly count: number;
  readonly msBeforeNext: number;
}

/**
 * The counters of the generic per-origin rate limiter (identity design 6.8 and 13): one fixed
 * window per limit class and origin key, shared by every API instance. Implemented in
 * `platform/persistence/` with the PostgreSQL store of `rate-limiter-flexible`. The key is the
 * keyed hash of the origin ({@link RateLimitOriginKeys}), never the address. A counter that
 * cannot be read or written rejects; the guard then fails closed.
 */
export interface RateLimitCounters {
  consume(limitClass: CountedClass, key: string): Promise<RateLimitCount>;
}

/** Nest token of the {@link RateLimitCounters}. */
export const RATE_LIMIT_COUNTERS = Symbol('RATE_LIMIT_COUNTERS');
