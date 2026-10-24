// Violation: the kernel has no clock; it never reads the wall clock.
export const violation = (): number => Date.now();
