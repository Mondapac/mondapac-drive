import { systemActor } from '@mondapac-drive/shared-kernel/contexts';

// Violation (contexts-are-built-by-platform): a module never builds an actor or a call
// context; it receives the CallContext from its platform entry adapter.
export const violation = systemActor({ marketId: 'ZZ' });
