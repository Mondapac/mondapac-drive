import { systemActor } from '@mondapac-drive/shared-kernel/contexts';

// Allowed: a platform entry adapter (here the scheduler) builds the system actor of a Market.
export const allowed = systemActor({ marketId: 'ZZ' });
