/** The team list as `GET identity/admin/team` answers (AdminTeamPageView); instants are ISO strings. */
export interface ActionHint {
  readonly allowed: boolean;
  readonly code: string | null;
}

export interface TeamRole {
  readonly roleId: string;
  readonly kind: 'system' | 'default' | 'custom';
  readonly seedCode: string | null;
}

export interface AccountRow {
  readonly type: 'account';
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly self: boolean;
  readonly role: TeamRole | null;
  readonly actions: {
    readonly changeRole: ActionHint;
    readonly disable: ActionHint;
    readonly enable: ActionHint;
    readonly resetSecondFactor: ActionHint;
  };
}

export interface InvitationRow {
  readonly type: 'invitation';
  readonly invitationId: string;
  readonly email: string;
  readonly role: TeamRole | null;
  readonly invitedByAccountId: string | null;
  readonly status: 'pending' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly actions: { readonly resend: ActionHint; readonly revoke: ActionHint };
}

export type TeamRow = AccountRow | InvitationRow;

export interface TeamPage {
  readonly items: readonly TeamRow[];
  readonly next: string | null;
}

/** One entry of `GET identity/admin/roles`. `grantable` is a hint; the commands check again. */
export interface PlatformRole {
  readonly roleId: string;
  readonly kind: 'system' | 'default' | 'custom';
  readonly seedCode: string | null;
  readonly permissionCount: number;
  readonly grantable: boolean;
}
