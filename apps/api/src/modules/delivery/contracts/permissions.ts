import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of delivery, pushed into the permission registry at bootstrap. A
// merchant's API key acts through the merchant system role and a courier through the courier
// system role, each holding every key of its scope; admins through the platform roles
// (the seeded operator and dispatcher roles name the platform keys below).

const merchant = (key: string) =>
  definePermission('delivery', { key, scope: 'merchant', protected: false });
const courier = (key: string) =>
  definePermission('delivery', { key, scope: 'courier', protected: false });
const platform = (key: string) =>
  definePermission('delivery', { key, scope: 'platform', protected: false });

/** Price a delivery without booking it. */
export const QUOTE_CREATE = merchant('delivery.quote.create');
/** Book a delivery for the merchant of the key. */
export const BOOKING_CREATE = merchant('delivery.booking.create');
/** Read the merchant's own deliveries. */
export const BOOKING_VIEW = merchant('delivery.booking.view');
/** Cancel one of the merchant's own deliveries before pickup. */
export const BOOKING_CANCEL = merchant('delivery.booking.cancel');

/** Read the deliveries assigned to the courier. */
export const ASSIGNMENT_VIEW = courier('delivery.assignment.view');
/** Report progress, cold-chain readings and proof on the courier's own assignment. */
export const ASSIGNMENT_REPORT = courier('delivery.assignment.report');

/** Read every delivery of the Market (operators and dispatchers). */
export const DELIVERY_VIEW = platform('delivery.delivery.view');
/** Open dispatch, assign and unassign couriers. */
export const DELIVERY_DISPATCH = platform('delivery.delivery.dispatch');
/** Cancel any delivery of the Market before pickup. */
export const DELIVERY_CANCEL = platform('delivery.delivery.cancel');

/** Every permission delivery declares, for its module's registration. */
export const DELIVERY_PERMISSIONS = declarePermissions('delivery', [
  QUOTE_CREATE,
  BOOKING_CREATE,
  BOOKING_VIEW,
  BOOKING_CANCEL,
  ASSIGNMENT_VIEW,
  ASSIGNMENT_REPORT,
  DELIVERY_VIEW,
  DELIVERY_DISPATCH,
  DELIVERY_CANCEL,
]);
