import {
  effectiveKeysOf,
  registryView,
  type EffectiveKeyResolver,
} from '../../src/modules/identity/application/access/effective-keys';
import { DELIVERY_PERMISSIONS } from '../../src/modules/delivery/contracts/permissions';
import { IDENTITY_PERMISSIONS } from '../../src/modules/identity/contracts/permissions';
import { TRACKING_PERMISSIONS } from '../../src/modules/tracking/contracts/permissions';
import { PermissionRegistry } from '../../src/platform/authz/permission-registry';

/**
 * The permission registry as the application builds it (identity slice 8a-1): the real
 * catalogues of every module that declares keys, pushed and sealed. For unit tests that need
 * "the real registry" without booting the application; the contracts test checks that the
 * booted registry holds exactly these catalogues.
 */
export function realPermissionRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register('identity', IDENTITY_PERMISSIONS);
  registry.register('delivery', DELIVERY_PERMISSIONS);
  registry.register('tracking', TRACKING_PERMISSIONS);
  registry.seal();
  return registry;
}

/** The resolver `EFFECTIVE_KEY_RESOLVER` binds, over {@link realPermissionRegistry}. */
export function realEffectiveKeys(
  registry: PermissionRegistry = realPermissionRegistry(),
): EffectiveKeyResolver {
  const view = registryView(registry);
  return (subject) => effectiveKeysOf(subject, view);
}
