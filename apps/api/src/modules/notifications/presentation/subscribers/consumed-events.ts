import { defineEvent, eventField, POPULATIONS } from '@mondapac-drive/shared-kernel';

// The dispatch and identity events notifications consumes for courier push, declared here as
// their modules publish them: notifications imports neither module (dispatch's index exports its
// Nest module only; identity's events are an untyped list). Only the type and the fields matter
// to the dispatcher's decoding; the contracts test
// (test/contracts/notifications-consumed-events.contract.spec.ts) holds each one equal to the
// entry of the checked-in event catalogue snapshot, so a change on the publisher's side fails CI.

/** One offer dispatch sent to a courier; the offer id is the envelope's aggregate id. */
export const DISPATCH_OFFER_SENT = defineEvent({
  type: 'dispatch.offer-sent.v1',
  aggregateType: 'dispatch-offer',
  payload: {
    jobId: eventField.id(),
    deliveryId: eventField.id(),
    courierId: eventField.id(),
    round: eventField.integer(),
    expiresAt: eventField.instant(),
  },
});

/** An account was disabled: every session of it was revoked. */
export const IDENTITY_ACCOUNT_DISABLED = defineEvent({
  type: 'identity.account-disabled.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id(), population: eventField.enumOf(POPULATIONS) },
});

/** A password was replaced: every session (a reset) or every other one (a change) was revoked. */
export const IDENTITY_PASSWORD_CHANGED = defineEvent({
  type: 'identity.account-password-changed.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    cause: eventField.enumOf(['reset', 'change'] as const),
  },
});

/** The holder signed out every other session of the account. */
export const IDENTITY_OTHER_SESSIONS_SIGNED_OUT = defineEvent({
  type: 'identity.account-other-sessions-signed-out.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id() },
});

export const CONSUMED_PUSH_EVENTS = [
  DISPATCH_OFFER_SENT,
  IDENTITY_ACCOUNT_DISABLED,
  IDENTITY_PASSWORD_CHANGED,
  IDENTITY_OTHER_SESSIONS_SIGNED_OUT,
] as const;
