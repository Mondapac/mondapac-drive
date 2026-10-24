// The only import of the Temporal polyfill in the repository (ADR-0020 decision 7). All
// other code imports `Temporal` from the kernel, so the move to native Temporal changes
// this file only. The kernel installs no global `Temporal`.
import { Temporal } from 'temporal-polyfill';

export { Temporal };

/**
 * The only source of the current time (ADR-0005 decision 5). Implementations are injected;
 * tests use a fake.
 *
 * `now()` is an instant with no zone, truncated to the millisecond, so it survives a
 * database timestamp, JSON and a UUIDv7 timestamp unchanged. A local date or time needs the
 * IANA zone of the owning party, passed explicitly: a clock has no zone and no `today()`.
 */
export interface Clock {
  now(): Temporal.Instant;
}
