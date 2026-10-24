import { ApiProperty } from '@nestjs/swagger';

const NEW_PASSWORD =
  "The new password: within the Market's length limits, counted in characters after Unicode " +
  'NFKC (never fewer than 15 nor more than 128); at most 1024 bytes; not equal to the email or ' +
  'the display name; not a common password. Never trimmed, logged or echoed.';

/** "Forgot password?" (`ux.md` A5): the sign-in email of the account. */
export class PasswordResetEmailRequest {
  @ApiProperty({ description: 'The sign-in email of the account.', maxLength: 254 })
  email!: string;
}

/** The answer for every address, whether or not a mail goes (AC 21). */
export class PasswordResetAccepted {
  @ApiProperty({ enum: ['password-reset.accepted'] })
  code!: 'password-reset.accepted';
}

/** Completing a reset (`ux.md` A6): the link's token and the new password. */
export class ResetPasswordRequest {
  @ApiProperty({
    description:
      "The token from the fragment of the mail's link (never in a URL the server sees). Never " +
      'logged or echoed.',
    example: 'ml1_…',
  })
  token!: string;

  @ApiProperty({ description: NEW_PASSWORD, format: 'password' })
  password!: string;
}

/** The password was replaced; every session of the account ended. The user signs in again. */
export class PasswordChanged {
  @ApiProperty({ enum: ['password-changed'] })
  code!: 'password-changed';
}

/** A signed-in change (`ux.md` B4): the current password and the new one. */
export class ChangePasswordRequest {
  @ApiProperty({
    description: 'The current password, at most 1024 bytes. Never trimmed, logged or echoed.',
    format: 'password',
  })
  currentPassword!: string;

  @ApiProperty({ description: NEW_PASSWORD, format: 'password' })
  newPassword!: string;

  @ApiProperty({
    required: false,
    description:
      'A code from the authenticator app, or a recovery code. Required for an admin; not ' +
      'accepted for a courier.',
  })
  code?: string;
}

/**
 * The password was changed. The current session continues with a new token, set in the cookie
 * only; the CSRF token below replaces the old one. Every other session of the account ended.
 */
export class PasswordChangedInSession {
  @ApiProperty({ enum: ['password-changed'] })
  code!: 'password-changed';

  @ApiProperty({ description: 'The new CSRF token of the rotated session.' })
  csrfToken!: string;
}

/**
 * The courier's password was changed. The current session continues with the new token in
 * `token`, which the app keeps in place of the old one. Every other session of the account ended.
 */
export class CourierPasswordChanged {
  @ApiProperty({ enum: ['password-changed'] })
  code!: 'password-changed';

  @ApiProperty({ description: "The rotated session's new bearer token." })
  token!: string;
}
