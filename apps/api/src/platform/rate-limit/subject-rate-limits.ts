import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { localRateLimitSecret } from './origin-keys';
import {
  RATE_LIMIT_COUNTERS,
  type RateLimitCounters,
  type SubjectLimitClass,
} from './rate-limit-counters';

/** The HKDF info of subject keys: distinct from the origin keys and every module's label. */
const SUBJECT_KEY_INFO = 'platform.rate-limit.subject';
const SECRET_BYTES = 32;

/** One counted attempt of a subject: the window's count so far, this one included. */
export interface SubjectCount {
  readonly count: number;
  /** Whole seconds until the window ends, at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * Per-subject counters on the shared table of the per-origin limiter (buyer assistant package 4):
 * a module names a subject (a guest token hash, an account id, an origin, always with its
 * Market) and gets the count of the class's fixed window, shared by every API instance. The
 * module compares it with its own limit, so the limit can be a Market setting. The stored key is
 * the keyed hash of the subject, never the subject. A counter that cannot be read rejects; the
 * caller fails closed.
 */
@Injectable()
export class SubjectRateLimits {
  readonly #key: Buffer;

  constructor(
    @Inject(RATE_LIMIT_COUNTERS) private readonly counters: RateLimitCounters,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.#key = Buffer.from(
      hkdfSync(
        'sha256',
        localRateLimitSecret(config),
        new Uint8Array(0),
        SUBJECT_KEY_INFO,
        SECRET_BYTES,
      ),
    );
  }

  async count(limitClass: SubjectLimitClass, subject: string): Promise<SubjectCount> {
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new TypeError('A rate-limit subject is a non-empty string');
    }
    const key = createHmac('sha256', this.#key).update(subject).digest('hex');
    const counted = await this.counters.consume(limitClass, key);
    return {
      count: counted.count,
      retryAfterSeconds: Math.max(1, Math.ceil(counted.msBeforeNext / 1000)),
    };
  }
}
