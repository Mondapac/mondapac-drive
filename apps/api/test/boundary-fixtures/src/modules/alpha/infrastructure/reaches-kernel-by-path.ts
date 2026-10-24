import { isMinted } from '../../../../packages/shared-kernel/src/minted';

// Violation: the kernel is reached by its package name only, never by a path into it.
export const violation = isMinted;
