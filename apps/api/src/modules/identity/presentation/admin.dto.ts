import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const CODE =
  'Six digits from the authenticator app (one inner space or hyphen allowed). Never logged or ' +
  'echoed.';
const CODE_OR_RECOVERY =
  'Six digits from the authenticator app, or one recovery code (ten characters, "XXXXX-XXXXX"; ' +
  'case, spaces and hyphens ignored). Never logged or echoed.';
const NEW_PASSWORD =
  "The new password: within the Market's length limits, counted in characters after Unicode " +
  'NFKC; at most 1024 bytes; not equal to the email or the display name; not a common ' +
  'password. Never trimmed, logged or echoed.';

/** The body of an admin's password step (identity design 6.3 steps 1 to 5). */
export class AdminSignInRequest {
  @ApiProperty({ description: 'The sign-in email of the admin account.', maxLength: 254 })
  email!: string;

  @ApiProperty({
    description: 'The password, at most 1024 bytes. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;
}

/**
 * Where a correct admin password leads (6.3 step 5): never to a session. With an active factor,
 * a challenge whose token is posted back with the code; with none, an enrolment link was mailed.
 */
export class AdminSignInStep {
  @ApiProperty({ enum: ['second-factor-required', 'second-factor-enrolment-required'] })
  code!: 'second-factor-required' | 'second-factor-enrolment-required';

  @ApiPropertyOptional({
    description:
      'With second-factor-required: the challenge token, posted back with the code. Not a ' +
      'credential; it works for a few minutes and a few attempts.',
    example: 'mc1_…',
  })
  challengeToken?: string;

  @ApiPropertyOptional({
    description: "With second-factor-required: the challenge's expiry, ISO 8601 UTC.",
  })
  expiresAt?: string;
}

/** The code step of an admin sign-in (6.3 steps 5 to 7). */
export class AdminSecondFactorRequest {
  @ApiProperty({ description: 'The token of the challenge from the password step.' })
  challengeToken!: string;

  @ApiProperty({ description: CODE_OR_RECOVERY })
  code!: string;
}

/** A signed-in admin answer. The token travels only in `__Host-session-admin-<MARKET>`. */
export class AdminSignedIn {
  @ApiProperty({ enum: ['signed-in'] })
  code!: 'signed-in';

  @ApiProperty({ description: 'Send as x-csrf-token on every POST, PUT, PATCH and DELETE.' })
  csrfToken!: string;
}

/** Starting an enrolment from the mailed link (3.6, HF6): the link's token and the password. */
export class AdminEnrolmentRequest {
  @ApiProperty({
    description: "The token from the fragment of the mail's link. Never logged or echoed.",
    example: 'ml1_…',
  })
  token!: string;

  @ApiProperty({
    description: 'The password of the account, at most 1024 bytes. Never logged or echoed.',
    format: 'password',
  })
  password!: string;
}

/** A new secret to add to the app; shown once. The panel draws the QR code itself (7.1). */
export class AdminEnrolmentStarted {
  @ApiProperty({ enum: ['second-factor-enrolment-started'] })
  code!: 'second-factor-enrolment-started';

  @ApiProperty({ description: 'The challenge token, posted back with the first code.' })
  challengeToken!: string;

  @ApiProperty({ description: "The challenge's expiry, ISO 8601 UTC." })
  expiresAt!: string;

  @ApiProperty({ description: 'The secret as base32 text, for typing into the app. Shown once.' })
  secret!: string;

  @ApiProperty({ description: 'The otpauth:// URI of the secret, for the QR code. Shown once.' })
  otpauthUri!: string;
}

/** Confirming an enrolment: the challenge token and the first app code. */
export class AdminEnrolmentConfirmRequest {
  @ApiProperty({ description: 'The challenge token from the enrolment start.' })
  challengeToken!: string;

  @ApiProperty({ description: CODE })
  code!: string;
}

/** Ten recovery codes, each usable once; shown only in this answer. */
export class RecoveryCodesShown {
  @ApiProperty({
    enum: ['second-factor-activated', 'recovery-codes-regenerated', 'invitation.accepted'],
  })
  code!: string;

  @ApiProperty({ type: [String], description: 'Ten codes, "XXXXX-XXXXX". Shown once.' })
  recoveryCodes!: string[];
}

/** A code typed by the signed-in admin. */
export class AdminCodeRequest {
  @ApiProperty({ description: CODE_OR_RECOVERY })
  code!: string;
}

/** A code from the new device, to complete a replacement. */
export class AdminNewDeviceCodeRequest {
  @ApiProperty({ description: CODE })
  code!: string;
}

/** The new device's secret, waiting for its first code (M13); shown once. */
export class AdminReplacementStarted {
  @ApiProperty({ enum: ['second-factor-replacement-started'] })
  code!: 'second-factor-replacement-started';

  @ApiProperty({ description: 'The secret as base32 text. Shown once.' })
  secret!: string;

  @ApiProperty({ description: 'The otpauth:// URI of the secret, for the QR code. Shown once.' })
  otpauthUri!: string;
}

/** The new device is the factor; the session continues with a new token and CSRF token. */
export class AdminReplacementCompleted {
  @ApiProperty({ enum: ['second-factor-replaced'] })
  code!: 'second-factor-replaced';

  @ApiProperty({ description: 'The new CSRF token of the rotated session.' })
  csrfToken!: string;
}

/** The invitation token, to start an acceptance (3.4, HF6). */
export class AdminInvitationTokenRequest {
  @ApiProperty({
    description: "The token from the fragment of the invitation's link. Never logged or echoed.",
    example: 'mi1_…',
  })
  token!: string;
}

/** A new secret bound to the invitation for 15 minutes; nothing is stored yet. */
export class AdminInvitationEnrolmentReady {
  @ApiProperty({ enum: ['invitation.enrolment-ready'] })
  code!: 'invitation.enrolment-ready';

  @ApiProperty({ description: 'The secret as base32 text. Shown once; posted back to accept.' })
  secret!: string;

  @ApiProperty({ description: 'The otpauth:// URI of the secret, for the QR code.' })
  otpauthUri!: string;

  @ApiProperty({ description: "The secret's tag, posted back unchanged to accept." })
  tag!: string;

  @ApiProperty({ description: "The secret's expiry, ISO 8601 UTC, posted back unchanged." })
  expiresAt!: string;
}

/** Accepting an admin invitation: name, password, the secret's three parts and the first code. */
export class AdminAcceptInvitationRequest {
  @ApiProperty({ description: 'The invitation token. Never logged or echoed.' })
  token!: string;

  @ApiProperty({
    description:
      "The person's display name: 1 to 100 characters after trimming, no control or bidi " +
      'characters, no URL-like text. Personal data: never logged.',
    maxLength: 100,
  })
  displayName!: string;

  @ApiProperty({ description: NEW_PASSWORD, format: 'password' })
  password!: string;

  @ApiProperty({ description: 'The secret, as returned by the enrolment step.' })
  secret!: string;

  @ApiProperty({ description: 'The tag, as returned by the enrolment step.' })
  tag!: string;

  @ApiProperty({ description: 'The expiry, as returned by the enrolment step.' })
  expiresAt!: string;

  @ApiProperty({ description: CODE })
  code!: string;
}

/** A signed-in admin's password change (Hassan I2 (b)): both passwords and a code. */
export class AdminChangePasswordRequest {
  @ApiProperty({ description: 'The current password. Never logged or echoed.', format: 'password' })
  currentPassword!: string;

  @ApiProperty({ description: NEW_PASSWORD, format: 'password' })
  newPassword!: string;

  @ApiProperty({ description: CODE_OR_RECOVERY })
  code!: string;
}

class AdminSessionTimes {
  @ApiProperty({ description: 'The idle timeout in seconds, counted from the last request.' })
  idleTimeoutSeconds!: number;

  @ApiProperty({ description: 'The absolute expiry, ISO 8601 UTC; never extended.' })
  absoluteExpiresAt!: string;
}

/** The actor summary of identity design 8.6 rows 2 and 9, for an admin. */
export class AdminSessionSummary {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ enum: ['admin'] })
  population!: 'admin';

  @ApiProperty({ type: String, nullable: true, description: "The account's role." })
  roleId!: string | null;

  @ApiProperty({ type: [String], description: 'The keys the role grants now, sorted.' })
  permissionKeys!: string[];

  @ApiProperty()
  secondFactorActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'The previous successful sign-in before this session (ISO 8601 UTC), or null when the ' +
      'records no longer hold one. The time only, never an address.',
  })
  lastSignInAt!: string | null;

  @ApiProperty({ description: 'The sign-in email (personal data: shown to its owner only).' })
  email!: string;

  @ApiProperty({ description: "The person's display name (personal data)." })
  displayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The holder's own IANA time zone, or null.",
  })
  timezone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The holder's panel language, or null.",
  })
  locale!: string | null;

  @ApiProperty({ type: AdminSessionTimes })
  session!: AdminSessionTimes;

  @ApiProperty({ description: 'Send as x-csrf-token on every unsafe request of this session.' })
  csrfToken!: string;
}
