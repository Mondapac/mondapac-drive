import { authenticatedActor } from '@mondapac-drive/shared-kernel/authenticated-actor';

// Violation: the platform builds anonymous and system actors only; an authenticated actor comes
// from identity's Authenticator.
export const violation = authenticatedActor('account');
