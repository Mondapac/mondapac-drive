import { a } from './circular-a';

// The other half of the cycle; dependency-cruiser reports the cycle once, from circular-a.
export const b = (): string => typeof a;
