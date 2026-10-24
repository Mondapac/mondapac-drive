/**
 * The one reader of the wall clock in the app (the API's Clock rule). Everything that needs
 * the time takes a Clock, so that tests run on a fake one.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that moves only when a test moves it. */
export function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}
