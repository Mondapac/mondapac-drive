/** Whole seconds left until an offer expires, never below zero. */
export function secondsLeft(expiresAt: string, nowMs: number): number {
  const remaining = Date.parse(expiresAt) - nowMs;
  return Number.isNaN(remaining) ? 0 : Math.max(0, Math.ceil(remaining / 1000));
}
