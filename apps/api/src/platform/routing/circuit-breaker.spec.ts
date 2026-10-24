import { Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker', () => {
  const start = Temporal.Instant.from('2026-10-24T00:00:00Z');

  it('opens after the threshold of consecutive failures and refuses calls', () => {
    const breaker = new CircuitBreaker(new FixedClock(start), 3, 30);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('a success resets the count of failures', () => {
    const breaker = new CircuitBreaker(new FixedClock(start), 2, 30);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('lets one trial call through after the open period, and closes on its success', () => {
    const clock = new FixedClock(start);
    const breaker = new CircuitBreaker(clock, 1, 30);
    breaker.recordFailure();
    clock.advance(Temporal.Duration.from({ seconds: 29 }));
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    expect(breaker.state).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens again at once when the trial call fails', () => {
    const clock = new FixedClock(start);
    const breaker = new CircuitBreaker(clock, 5, 10);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    clock.advance(Temporal.Duration.from({ seconds: 10 }));
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });
});
