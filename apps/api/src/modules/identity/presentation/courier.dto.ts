import { ApiProperty } from '@nestjs/swagger';

export class CourierSignInRequest {
  @ApiProperty({ description: 'The sign-in address. Never logged or echoed.', maxLength: 254 })
  email!: string;

  @ApiProperty({ description: 'Never logged or echoed.' })
  password!: string;
}

export class CourierSignedIn {
  @ApiProperty({ enum: ['signed-in'] })
  code!: 'signed-in';

  @ApiProperty({
    description:
      'The session token: the app keeps it in the device keystore and sends it as ' +
      '`Authorization: Bearer <token>`. Never put in a URL or a log.',
  })
  token!: string;

  @ApiProperty({ description: 'The session ends this many seconds after sign-in.' })
  absoluteLifetimeSeconds!: number;

  @ApiProperty({ description: 'The session ends after this many seconds without a request.' })
  idleTimeoutSeconds!: number;
}

export class CourierAcceptInvitationRequest {
  @ApiProperty({ description: 'The token of the invitation mail. Never logged or echoed.' })
  token!: string;

  @ApiProperty({ description: 'The name dispatchers see.', maxLength: 64 })
  displayName!: string;

  @ApiProperty({ description: 'The new password, under the Market rules. Never logged.' })
  password!: string;
}

export class CourierInvitationAccepted {
  @ApiProperty({
    enum: ['invitation.accepted'],
    description: 'The account exists; the courier signs in from the app.',
  })
  code!: 'invitation.accepted';
}
