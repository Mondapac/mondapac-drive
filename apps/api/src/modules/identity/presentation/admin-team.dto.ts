import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the admin team routes (identity design 3.1, 3.4, 3.6, 5.3, 5.5, 8.6;
// slices 8a-2 and 8b). Ids and codes only: no answer carries an address, a name or a role name.

const UUID = 'A UUID v7.';

/** Change an admin's role (5.3 `identity.platform-role.assign`). */
export class AdminAssignRoleRequest {
  @ApiProperty({ description: `The platform role to assign. ${UUID}`, format: 'uuid' })
  roleId!: string;
}

/** Invite an admin with a role (3.4; `identity.admin-account.invite`). */
export class AdminInviteRequest {
  @ApiProperty({
    description: "The invitee's sign-in address. Never logged, echoed or audited.",
    maxLength: 254,
  })
  email!: string;

  @ApiProperty({ description: `The platform role the invitee will hold. ${UUID}`, format: 'uuid' })
  roleId!: string;
}

/** A route that takes no fields: the body is `{}` (JSON only, 6.4). */
export class AdminEmptyRequest {}

export class AdminRoleAssigned {
  @ApiProperty({
    enum: ['role.assigned', 'role.unchanged'],
    description: 'role.unchanged: the account already held the role; nothing was written.',
  })
  code!: 'role.assigned' | 'role.unchanged';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ format: 'uuid' })
  roleId!: string;
}

export class AdminAccountStatusChanged {
  @ApiProperty({
    enum: ['account.disabled', 'account.enabled'],
    description: 'A disable revoked every session of the account and voided its open sign-ins.',
  })
  code!: 'account.disabled' | 'account.enabled';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;
}

export class AdminSecondFactorReset {
  @ApiProperty({
    enum: ['second-factor.reset'],
    description:
      'The factor was removed, every session revoked and the account mailed; its next ' +
      'sign-in mails an enrolment link.',
  })
  code!: 'second-factor.reset';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;
}

export class AdminInvitationIssued {
  @ApiProperty({
    enum: ['invitation.issued'],
    description: 'The invitation exists; its mail is sent shortly, with a new token.',
  })
  code!: 'invitation.issued';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

export class AdminInvitationChanged {
  @ApiProperty({
    enum: ['invitation.reissued', 'invitation.revoked'],
    description: 'reissued: the earlier link stopped working and a new mail follows.',
  })
  code!: 'invitation.reissued' | 'invitation.revoked';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

// The admin team list (slice 8c; identity design 8.6 rows 2 and 6). Personal data (address,
// name) goes to the actor entitled to it; never a token, a hash or a factor secret.

export class AdminTeamActionHint {
  @ApiProperty({
    description: 'Whether the action is allowed now. A hint: the command checks again.',
  })
  allowed!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null when allowed; otherwise the code the command would answer now: access.denied (the ' +
      'actor lacks its permission), member.self, member.outranks-actor, member.last-holder, ' +
      'account.already-disabled, account.already-active, second-factor.none, ' +
      'invitation.rejected, role.not-grantable, access.unavailable or account.unknown.',
  })
  code!: string | null;
}

export class AdminTeamRoleView {
  @ApiProperty({ format: 'uuid' })
  roleId!: string;

  @ApiProperty({ enum: ['system', 'default', 'custom'], description: 'system: show a lock.' })
  kind!: 'system' | 'default' | 'custom';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The seed code of a system or default role (its label key); null for custom.',
  })
  seedCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name of a custom role (personal data). Null for a seeded role.',
  })
  name!: string | null;
}

export class AdminTeamAccountActions {
  @ApiProperty({
    type: AdminTeamActionHint,
    description: 'Change role, for the row: whether a given role is grantable is not a row hint.',
  })
  changeRole!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  disable!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  enable!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  resetSecondFactor!: AdminTeamActionHint;
}

export class AdminTeamInvitationActions {
  @ApiProperty({ type: AdminTeamActionHint })
  resend!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  revoke!: AdminTeamActionHint;
}

export class AdminTeamAccountRowView {
  @ApiProperty({ enum: ['account'] })
  type!: 'account';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ description: 'The sign-in address.' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ enum: ['active', 'disabled'] })
  status!: 'active' | 'disabled';

  @ApiProperty({ description: "The actor's own row." })
  self!: boolean;

  @ApiProperty({ type: AdminTeamRoleView, nullable: true })
  role!: AdminTeamRoleView | null;

  @ApiProperty({ type: AdminTeamAccountActions })
  actions!: AdminTeamAccountActions;
}

export class AdminTeamInvitationRowView {
  @ApiProperty({ enum: ['invitation'] })
  type!: 'invitation';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;

  @ApiProperty({ description: 'The invited address.' })
  email!: string;

  @ApiProperty({
    type: AdminTeamRoleView,
    nullable: true,
    description: 'Null when the role no longer exists: the invitation cannot be accepted.',
  })
  role!: AdminTeamRoleView | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The inviter; null for the first-admin invitation.',
  })
  invitedByAccountId!: string | null;

  @ApiProperty({
    enum: ['pending', 'expired'],
    description: 'expired: past the expiry of its last mail (it may still be re-sent).',
  })
  status!: 'pending' | 'expired';

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null until its mail is sent, and right after a re-send.',
  })
  expiresAt!: string | null;

  @ApiProperty({ type: AdminTeamInvitationActions })
  actions!: AdminTeamInvitationActions;
}

export class AdminTeamPageView {
  @ApiProperty({
    description:
      'Admin accounts and pending admin invitations of the Market, merged by id (creation ' +
      'order); `type` tells them apart.',
    type: 'array',
    items: {
      oneOf: [
        { $ref: '#/components/schemas/AdminTeamAccountRowView' },
        { $ref: '#/components/schemas/AdminTeamInvitationRowView' },
      ],
    },
  })
  items!: (AdminTeamAccountRowView | AdminTeamInvitationRowView)[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `after` for the next page; null on the last page.',
  })
  next!: string | null;
}
