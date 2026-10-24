import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of tracking, pushed into the permission registry at bootstrap. A
// courier acts through the courier system role, which holds every courier key; operators and
// dispatchers through the platform roles that name the platform key below.

/** Send the courier's own location pings from the courier app. */
export const LOCATION_RECORD = definePermission('tracking', {
  key: 'tracking.location.record',
  scope: 'courier',
  protected: false,
});

/** See couriers' live positions and delivery trails on the dispatcher map. */
export const MAP_VIEW = definePermission('tracking', {
  key: 'tracking.map.view',
  scope: 'platform',
  protected: false,
});

/** Every permission tracking declares, for its module's registration. */
export const TRACKING_PERMISSIONS = declarePermissions('tracking', [LOCATION_RECORD, MAP_VIEW]);
