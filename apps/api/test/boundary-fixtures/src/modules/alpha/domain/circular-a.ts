import { b } from './circular-b';

// Violation: circular-a and circular-b import each other.
export const a = (): string => b();
