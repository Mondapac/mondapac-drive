// The `@mondapac-drive/shared-kernel/contexts` entry: the constructors of the actor and call
// contexts (platform-foundations design 3.7; identity slice 1c). Only the platform's entry
// adapters build these contexts, so this entry is reachable from `apps/api/src/platform/` and
// from tests only (dependency-cruiser rule `contexts-are-built-by-platform`). The types, the
// minted check and `ContextMismatchError` stay on the main entry, which every layer may import.
//
// Named exports only. The authenticated-actor constructor is not here: it has its own entry,
// `@mondapac-drive/shared-kernel/authenticated-actor` (identity slice 2), reachable from the one file
// of `identity` that builds actors (3.7).
export { anonymousActor, systemActor } from './actor-context';
export { createCallContext } from './call-context';
