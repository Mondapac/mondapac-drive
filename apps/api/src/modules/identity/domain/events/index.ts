import { defineEvent, eventField, POPULATIONS } from '@mondapac-drive/shared-kernel';
import type { EventDefinition } from '@mondapac-drive/shared-kernel';

/** The purposes of a one-time link (identity design 3.7; data design 3.7). */
export const LINK_PURPOSES = ['reset-password', 'enrol-second-factor'] as const;

/**
 * A one-time link was requested (identity design 3.7 and 6.6): the row exists without a token;
 * identity's own mail handler mints the token, sends the mail and stores the hash (9). Not
 * recorded when the mail counters refused the mail (Mojtaba, item 3): the request's verdict
 * travels in the unit, and the handler never reads a counter.
 */
export const OneTimeLinkRequested = defineEvent({
  type: 'identity.one-time-link-requested.v1',
  aggregateType: 'one-time-link',
  payload: {
    linkId: eventField.id(),
    accountId: eventField.id(),
    purpose: eventField.enumOf(LINK_PURPOSES),
  },
});

/** Why an account's password was replaced (identity design 3.5, 3.7, 8.2; slice 4). */
export const PASSWORD_CHANGE_CAUSES = ['reset', 'change'] as const;

/**
 * The account's password was replaced (identity design 3.7, 6.5, 8.2; slice 4): through a reset
 * link (`reset`) or by the signed-in holder with the current password (`change`). In the same unit
 * the account's sessions were revoked (all of them on a reset, all but the rotated current one on
 * a change). Drives the "password changed" notice (`ux.md` E13). Ids and codes only.
 */
export const AccountPasswordChanged = defineEvent({
  type: 'identity.account-password-changed.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    cause: eventField.enumOf(PASSWORD_CHANGE_CAUSES),
  },
});

/**
 * The holder changed the own display name (profile package). Ids and codes only: the name is
 * personal data and never goes into an event.
 */
export const AccountDisplayNameChanged = defineEvent({
  type: 'identity.account-display-name-changed.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/**
 * The holder signed out every other session of the own account from "Signed-in devices"
 * (profile package 4; Hassan's follow-up). Recorded only when at least one session was ended.
 * Drives the "your other devices were signed out" notice, so a holder whose session was taken
 * learns of it. Ids only.
 */
export const AccountOtherSessionsSignedOut = defineEvent({
  type: 'identity.account-other-sessions-signed-out.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id() },
});

/** The kinds of an invitation: an admin (operator or dispatcher), or a courier. */
export const INVITATION_KINDS = ['admin', 'courier'] as const;

/**
 * An invitation was issued (identity design 3.4, 8.2; slice 7b: the first-admin routine; a re-send
 * from slice 8b). The row exists without a token; identity's own mail handler mints the token,
 * sends the mail and stores the hash and the expiry (6.6). Ids and codes only: never the invited
 * address or a name.
 */
export const InvitationIssued = defineEvent({
  type: 'identity.invitation-issued.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
  },
});

/**
 * An invitation was accepted (identity design 3.4, 8.2; slice 7b): the account named here was
 * created, with its assignment (and, for an admin, its active second factor), in the same unit.
 */
export const InvitationAccepted = defineEvent({
  type: 'identity.invitation-accepted.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
    accountId: eventField.id(),
  },
});

/**
 * What happened to a second factor (identity design 3.6, 6.8, 8.2): `activated` (an enrolment
 * completed, inside an invitation's acceptance or from a link), `replaced` (a new device swapped
 * in), `recovery-codes-regenerated`, `reset` (the factor returned to `none`) and `locked` (HF2:
 * the `second-factor.account` counter reached its limit; the event sends the alert mail).
 */
export const SECOND_FACTOR_CHANGES = [
  'activated',
  'replaced',
  'recovery-codes-regenerated',
  'reset',
  'locked',
] as const;
export type SecondFactorChange = (typeof SECOND_FACTOR_CHANGES)[number];

/**
 * A second factor changed (identity design 3.6, 8.2; slice 7b). Ids and a code only: never the
 * secret, a code or a recovery code. Drives the mail of `replaced`, `reset` and `locked` (9).
 */
export const SecondFactorChanged = defineEvent({
  type: 'identity.second-factor-changed.v1',
  aggregateType: 'second-factor',
  payload: {
    accountId: eventField.id(),
    change: eventField.enumOf(SECOND_FACTOR_CHANGES),
  },
});

/**
 * An admin or courier account was disabled by an admin (identity design 3.1, 8.2; slice 8b). In
 * the same unit every session of the account was revoked and its open challenges voided. Ids and
 * a code only.
 */
export const AccountDisabled = defineEvent({
  type: 'identity.account-disabled.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/** A disabled account was enabled again by an admin (identity design 3.1, 8.2; slice 8b). */
export const AccountEnabled = defineEvent({
  type: 'identity.account-enabled.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/** The scopes of a role, as an event names them. */
export const ROLE_ASSIGNMENT_SCOPES = ['platform', 'merchant', 'courier'] as const;

/**
 * An account's role was changed by another account (identity design 8.2; slice 8a-2 for admins,
 * 11 for Staff). Not recorded for a founding assignment or for the assignment an invitation's
 * acceptance creates: `invitation-accepted` names that. Ids and codes only, never a role's name
 * (R5).
 */
export const AccountRoleChanged = defineEvent({
  type: 'identity.account-role-changed.v1',
  aggregateType: 'role-assignment',
  payload: {
    accountId: eventField.id(),
    scope: eventField.enumOf(ROLE_ASSIGNMENT_SCOPES),
    previousRoleId: eventField.id(),
    roleId: eventField.id(),
  },
});

/**
 * A custom role was created, edited or deleted in the role editor (identity design 8.2, 5.4 R5;
 * slice 10). Ids, scope and permission keys only: the role's name is personal free text and has
 * no path into an event. `addedKeys` and `removedKeys` are
 * the keys the change put in and took out (a created role adds all its keys, a deleted one
 * removes all).
 */
const ROLE_CHANGE_PAYLOAD = {
  roleId: eventField.id(),
  scope: eventField.enumOf(ROLE_ASSIGNMENT_SCOPES),
  addedKeys: eventField.listOf(eventField.permissionKey()),
  removedKeys: eventField.listOf(eventField.permissionKey()),
} as const;

export const RoleCreated = defineEvent({
  type: 'identity.role-created.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

export const RoleUpdated = defineEvent({
  type: 'identity.role-updated.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

export const RoleDeleted = defineEvent({
  type: 'identity.role-deleted.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

/**
 * A pending invitation was revoked by the inviter's side (identity design 3.4, 8.2; slice 8b), or
 * replaced by a new issue for the same address (item G). Ids and codes only.
 */
export const InvitationRevoked = defineEvent({
  type: 'identity.invitation-revoked.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
  },
});

/**
 * Every event identity publishes, declared with `defineEvent` (platform persistence design
 * 5.3; identity design 8.2) and registered with the event catalogue by `IdentityModule`. Each
 * new type changes the catalogue snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const IDENTITY_EVENTS: readonly EventDefinition[] = [
  OneTimeLinkRequested,
  AccountPasswordChanged,
  AccountDisplayNameChanged,
  AccountOtherSessionsSignedOut,
  InvitationIssued,
  InvitationAccepted,
  SecondFactorChanged,
  AccountDisabled,
  AccountEnabled,
  AccountRoleChanged,
  RoleCreated,
  RoleUpdated,
  RoleDeleted,
  InvitationRevoked,
];
