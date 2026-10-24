// Allowed: platform/clock/ is the only reader of the wall clock.
export function now(): [number, Date] {
  return [Date.now(), new Date()];
}
