import { Injectable } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Clock } from '@mondapac-drive/shared-kernel';

/**
 * The production Clock (ADR-0005 decision 5): the system time as an instant, truncated to the
 * millisecond. This directory is the only place that reads the wall clock; everything else
 * injects `CLOCK`.
 */
@Injectable()
export class SystemClock implements Clock {
  now(): Temporal.Instant {
    return Temporal.Instant.fromEpochMilliseconds(Date.now());
  }
}
