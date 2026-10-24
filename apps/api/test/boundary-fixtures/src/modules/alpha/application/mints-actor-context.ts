import {
  anonymousActor,
  createCallContext,
  systemActor,
} from '@mondapac-drive/shared-kernel/contexts';
import type { ActorContext, CallContext } from '@mondapac-drive/shared-kernel/contexts';

// Violations: a module mints no actor and no CallContext, and asserts no value to one of
// their types. The import of the `contexts` entry is refused by name as well.
export const violation = [
  anonymousActor(),
  systemActor(),
  createCallContext(systemActor()),
  {} as ActorContext,
  <CallContext>{},
];
