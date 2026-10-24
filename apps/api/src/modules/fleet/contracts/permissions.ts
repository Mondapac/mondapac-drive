import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of fleet, pushed into the permission registry at bootstrap. A courier
// acts through the courier system role, which holds every courier key; operators and
// dispatchers through the platform roles that name the platform keys below.

const courier = (key: string) =>
  definePermission('fleet', { key, scope: 'courier', protected: false });
const platform = (key: string) =>
  definePermission('fleet', { key, scope: 'platform', protected: false });

/** Apply to deliver, and keep one's own vehicles and documents. */
export const PROFILE_MANAGE = courier('fleet.profile.manage');
/** Go online and offline, pause, and come back from a delivery. */
export const SHIFT_CHANGE = courier('fleet.shift.change');

/** See the Market's couriers with their vehicles and documents, and download a document. */
export const COURIER_VIEW = platform('fleet.courier.view');
/** Approve, suspend, reinstate and offboard a courier, and record their tax registration. */
export const COURIER_DECIDE = platform('fleet.courier.decide');
/** Verify, reject and revoke a courier's document. */
export const DOCUMENT_REVIEW = platform('fleet.document.review');
/** Take a courier's vehicle out of use, and set its capacity. */
export const VEHICLE_MANAGE = platform('fleet.vehicle.manage');

/** Every permission fleet declares, for its module's registration. */
export const FLEET_PERMISSIONS = declarePermissions('fleet', [
  PROFILE_MANAGE,
  SHIFT_CHANGE,
  COURIER_VIEW,
  COURIER_DECIDE,
  DOCUMENT_REVIEW,
  VEHICLE_MANAGE,
]);
