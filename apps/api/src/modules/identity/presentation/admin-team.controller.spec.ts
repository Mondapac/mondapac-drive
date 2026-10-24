import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import type { AccountStatusFailure } from '../application/accounts/account-status';
import type { AssignAdminRoleFailure } from '../application/use-cases/assign-admin-role.use-case';
import type { InviteAdminFailure } from '../application/use-cases/invite-admin.use-case';
import type { ResendAdminInvitationFailure } from '../application/use-cases/resend-admin-invitation.use-case';
import type { ResetOtherAdminSecondFactorFailure } from '../application/use-cases/reset-other-admin-second-factor.use-case';
import type { RevokeAdminInvitationFailure } from '../application/use-cases/revoke-admin-invitation.use-case';
import { ADMIN_TEAM_STATUS } from './admin-team.controller';

// Sajad 3 on PR #187: every code a use case behind AdminTeamController can answer has an HTTP
// status, so no refusal of these routes becomes a 500. The record below is typed by the union of
// the use cases' failure codes and the gate's: a code added to a use case without a line here,
// or a line here that no use case answers, fails the type check.

type Code =
  | AssignAdminRoleFailure['code']
  | InviteAdminFailure['code']
  | ResendAdminInvitationFailure['code']
  | RevokeAdminInvitationFailure['code']
  | AccountStatusFailure['code']
  | ResetOtherAdminSecondFactorFailure['code']
  | AccessDenied['code'];

/** Every code, with the status identity design 5.2 and Mohammad's Q3 ruling give it. */
const EXPECTED: Readonly<Record<Code, number>> = {
  'validation.failed': 400,
  'access.unauthenticated': 401,
  'access.denied': 403,
  'access.seller-not-approved': 403,
  'member.self': 403,
  'member.outranks-actor': 403,
  'role.not-grantable': 403,
  'account.unknown': 404,
  'role.unknown': 404,
  'invitation.unknown': 404,
  'member.last-holder': 409,
  'account.already-disabled': 409,
  'account.already-active': 409,
  'account.exists': 409,
  'invitation.already-pending': 409,
  'invitation.rejected': 409,
  'second-factor.none': 409,
  'request.throttled': 429,
  'access.unavailable': 503,
};

describe('the HTTP status of every admin team refusal (Sajad 3)', () => {
  it.each(Object.entries(EXPECTED))('%s answers %i', (code, status) => {
    const mapped =
      ADMIN_TEAM_STATUS[code] ?? (ACCESS_DENIED_STATUS as Readonly<Record<string, number>>)[code];
    expect(mapped).toBe(status);
  });

  it('maps no code that no use case answers', () => {
    expect(Object.keys(ADMIN_TEAM_STATUS).filter((code) => !(code in EXPECTED))).toEqual([]);
  });
});
