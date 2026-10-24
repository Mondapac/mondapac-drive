import type { CallContext } from '@mondapac-drive/shared-kernel/contexts';

// Violation: the import path of the minting entry is refused for a module, even when only a
// type is taken from it (a module receives a context as a parameter, typed from the kernel
// main entry).
export type Received = CallContext;
