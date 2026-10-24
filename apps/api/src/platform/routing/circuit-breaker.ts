import type { Clock } from '@mondapac-drive/shared-kernel';

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * A consecutive-failure circuit breaker. Closed: calls go through, and `failureThreshold`
 * failures in a row open it. Open: calls are refused for `openSeconds`. Then one trial call is
 * let through (half open): success closes the breaker, failure opens it again.
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAtMs: number | undefined;
  #trialInFlight = false;

  constructor(
    private readonly clock: Clock,
    private readonly failureThreshold: number,
    private readonly openSeconds: number,
  ) {}

  get state(): BreakerState {
    if (this.#openedAtMs === undefined) return 'closed';
    const elapsedMs = this.clock.now().epochMilliseconds - this.#openedAtMs;
    return elapsedMs >= this.openSeconds * 1000 ? 'half_open' : 'open';
  }

  /** True when a call may go to the provider now; a half-open breaker admits one at a time. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.#trialInFlight) return false;
    this.#trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openedAtMs = undefined;
    this.#trialInFlight = false;
  }

  /**
   * The call ended without saying anything about the provider's health (a rejected request, a
   * bug): only frees a half-open trial, so the breaker cannot stay stuck.
   */
  recordNeutral(): void {
    this.#trialInFlight = false;
  }

  recordFailure(): void {
    this.#trialInFlight = false;
    this.#failures += 1;
    if (this.#openedAtMs !== undefined || this.#failures >= this.failureThreshold) {
      this.#openedAtMs = this.clock.now().epochMilliseconds;
    }
  }
}
