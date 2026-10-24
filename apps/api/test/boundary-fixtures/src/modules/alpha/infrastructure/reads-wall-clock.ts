// Violation: infrastructure/ may convert a Date, but it never reads the wall clock.
export function violation(): Date {
  return new Date();
}
