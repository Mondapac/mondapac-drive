// Violation: no Date in application/, not even a conversion.
export function violation(epochMilliseconds: number): Date {
  return new Date(epochMilliseconds);
}
