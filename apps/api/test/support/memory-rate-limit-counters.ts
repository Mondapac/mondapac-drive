import { RateLimiterMemory } from 'rate-limiter-flexible';
import { RATE_LIMIT_CLASSES } from '../../src/platform/rate-limit/rate-limit.decorator';
import {
  SUBJECT_LIMIT_WINDOWS,
  windowSecondsOf,
  type CountedClass,
  type RateLimitCount,
  type RateLimitCounters,
  type SubjectLimitClass,
} from '../../src/platform/rate-limit/rate-limit-counters';

/**
 * The counters of one process, in memory: what `createTestApp` puts in place of the PostgreSQL
 * store, so a suite without a database runs the real guard with the same fixed windows. A fresh
 * instance per application, so each test application starts with empty counters.
 */
export class MemoryRateLimitCounters implements RateLimitCounters {
  readonly #limiters: Readonly<Record<CountedClass, RateLimiterMemory>>;

  constructor() {
    const limiters = {} as Record<CountedClass, RateLimiterMemory>;
    const counted: readonly CountedClass[] = [
      ...RATE_LIMIT_CLASSES,
      ...(Object.keys(SUBJECT_LIMIT_WINDOWS) as SubjectLimitClass[]),
    ];
    for (const limitClass of counted) {
      limiters[limitClass] = new RateLimiterMemory({
        keyPrefix: limitClass,
        points: Number.MAX_SAFE_INTEGER,
        duration: windowSecondsOf(limitClass),
      });
    }
    this.#limiters = Object.freeze(limiters);
  }

  async consume(limitClass: CountedClass, key: string): Promise<RateLimitCount> {
    const counted = await this.#limiters[limitClass].consume(key);
    return { count: counted.consumedPoints, msBeforeNext: counted.msBeforeNext };
  }
}
