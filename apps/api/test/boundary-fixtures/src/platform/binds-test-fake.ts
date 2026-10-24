import { FixedClock } from '@mondapac-drive/shared-kernel/testing';

// Violation: a fake of the kernel's /testing entry bound in running code.
export const violation = new FixedClock();
