// Violation: no Date in domain/, not even a conversion.
export function violation(epochMilliseconds: number): Date {
  return new Date(epochMilliseconds);
}
