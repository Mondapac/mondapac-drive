import { authenticatedActor } from '@mondapac-drive/shared-kernel/authenticated-actor';

// Violation: another file of identity mints an authenticated actor.
export const violation = authenticatedActor('account');
