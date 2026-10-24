import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of dispatch, pushed into the permission registry at bootstrap. A
// courier acts through the courier system role, which holds every courier key; dispatchers and
// operators through the platform roles that name the platform keys below.

/** See the courier's own current offer in the courier app. */
export const OFFER_VIEW = definePermission('dispatch', {
  key: 'dispatch.offer.view',
  scope: 'courier',
  protected: false,
});

/** Accept or decline the courier's own offer. */
export const OFFER_ANSWER = definePermission('dispatch', {
  key: 'dispatch.offer.answer',
  scope: 'courier',
  protected: false,
});

/** See a delivery's dispatch job: its rounds, the offers sent and their answers. */
export const JOB_VIEW = definePermission('dispatch', {
  key: 'dispatch.job.view',
  scope: 'platform',
  protected: false,
});

/** Assign or reassign a delivery's courier, and restart offering after every round lapsed. */
export const JOB_ASSIGN = definePermission('dispatch', {
  key: 'dispatch.job.assign',
  scope: 'platform',
  protected: false,
});

/** Every permission dispatch declares, for its module's registration. */
export const DISPATCH_PERMISSIONS = declarePermissions('dispatch', [
  OFFER_VIEW,
  OFFER_ANSWER,
  JOB_VIEW,
  JOB_ASSIGN,
]);
