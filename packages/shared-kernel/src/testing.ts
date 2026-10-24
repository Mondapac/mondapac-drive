// Fakes and test builders: the `@mondapac-drive/shared-kernel/testing` entry. Tests only: nothing
// here may be bound in a running process, and nothing here is exported from the main entry.
import { anonymousActor, mintAuthenticatedActor, systemActor } from './actor-context';
import type { ActorContext, AuthenticatedActor, AuthenticatedActorFields } from './actor-context';
import { createCallContext } from './call-context';
import type { CallContext } from './call-context';
import { parseCorrelationId } from './correlation-id';
import { uuidV7 } from './id';
import type { Id, IdGenerator } from './id';
import { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
import type { MarketContext } from './market-context';
import { Temporal } from './time';
import type { Clock } from './time';

const toMillisecond = (instant: Temporal.Instant): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds);

/**
 * A clock that never ticks by itself: `now()` returns the same instant until the test calls
 * `advance()` or `set()`. Like every Clock it returns instants truncated to the millisecond.
 */
export class FixedClock implements Clock {
  private current: Temporal.Instant;

  constructor(start: Temporal.Instant) {
    this.current = toMillisecond(start);
  }

  now(): Temporal.Instant {
    return this.current;
  }

  advance(duration: Temporal.Duration): void {
    this.current = toMillisecond(this.current.add(duration));
  }

  set(instant: Temporal.Instant): void {
    this.current = toMillisecond(instant);
  }
}

/**
 * Valid version 7 ids that a test can predict: the clock's time and a counter in place of
 * the random bytes. The counter starts at 1 and never resets, so the ids of one generator
 * are unique and rise as long as its clock does not go back.
 */
export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly clock: Clock) {}

  next<K extends string>(): Id<K> {
    this.counter += 1;

    // The counter fills the low 6 of the 10 bytes; the layout uses every bit of those.
    const bytes = new Uint8Array(10);
    let rest = this.counter;
    for (let index = bytes.length - 1; index >= 4; index -= 1) {
      bytes[index] = rest % 256;
      rest = Math.floor(rest / 256);
    }

    return uuidV7(this.clock.now().epochMilliseconds, bytes) as Id<K>;
  }
}

/**
 * A minted MarketContext for a test. Both identifiers are explicit (a test has no default
 * Market either), are parsed first and go through the same mint function as production.
 */
export function testMarketContext(marketId: string, tenantId: string): MarketContext {
  const market = parseMarketId(marketId);
  if (!market.ok) throw new Error(`testMarketContext: malformed market id "${marketId}"`);
  const tenant = parseTenantId(tenantId);
  if (!tenant.ok) throw new Error(`testMarketContext: malformed tenant id "${tenantId}"`);

  return mintMarketContext(market.value, tenant.value);
}

/**
 * A minted authenticated actor for a test (identity design 4). Production builds one only in
 * `identity`'s `Authenticator` (slice 2); this builder calls the same constructor, with its
 * checks.
 */
export function testAuthenticatedActor(
  market: MarketContext,
  fields: AuthenticatedActorFields,
): AuthenticatedActor {
  return mintAuthenticatedActor(market, fields);
}

/** The correlation id {@link testCallContext} uses when a test does not name one. */
export const TEST_CORRELATION_ID = 'test-correlation-0001';

/**
 * A minted CallContext for a test, through the same constructor as the entry adapters. The
 * actor is named explicitly: `'anonymous'` or `'system'` for those actors of the Market, or an
 * actor the test built.
 */
export function testCallContext(
  market: MarketContext,
  actor: 'anonymous' | 'system' | ActorContext,
  correlationId: string = TEST_CORRELATION_ID,
): CallContext {
  const correlation = parseCorrelationId(correlationId);
  if (!correlation.ok) {
    throw new Error(`testCallContext: malformed correlation id "${correlationId}"`);
  }
  const resolved =
    actor === 'anonymous'
      ? anonymousActor(market)
      : actor === 'system'
        ? systemActor(market)
        : actor;
  return createCallContext(market, resolved, correlation.value);
}
