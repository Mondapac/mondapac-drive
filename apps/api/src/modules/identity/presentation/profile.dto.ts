import { ApiProperty } from '@nestjs/swagger';

/** The holder's new display name, as typed (the server trims and checks it). */
export class ChangeDisplayNameRequest {
  @ApiProperty({
    description:
      'The new display name: 1 to 100 characters after trimming, no control characters, no ' +
      'URL-like text. Personal data: never logged or put in an event.',
  })
  displayName!: string;
}

export class DisplayNameChanged {
  @ApiProperty({ enum: ['display-name-changed'] })
  code!: 'display-name-changed';

  @ApiProperty({ description: 'False when the name already was the one given.' })
  changed!: boolean;
}

/** The holder's display preferences; null means "no choice". */
export class ChangePanelPreferencesRequest {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'An IANA time zone id (for example Australia/Brisbane), or null for the default.',
  })
  timezone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A panel language code from the supported list (en), or null for the default.',
  })
  locale!: string | null;
}

export class PanelPreferencesChanged {
  @ApiProperty({ enum: ['panel-preferences-changed'] })
  code!: 'panel-preferences-changed';

  @ApiProperty({ description: 'False when the values already were the ones given.' })
  changed!: boolean;
}

/** One signed-in device of the holder (profile package 4). No id, token or address. */
export class OwnSession {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'chrome.windows',
    description:
      'The coarse device, `<browser>.<system>`. Browser: edge, opera, samsung, firefox, chrome, ' +
      'safari or other; system: windows, macos, ios, android, chromeos, linux or other. Null ' +
      'for a session opened before devices were kept.',
  })
  device!: string | null;

  @ApiProperty({ description: 'When the session was opened (ISO 8601, UTC).' })
  signedInAt!: string;

  @ApiProperty({ description: 'Its last request, to the minute (ISO 8601, UTC).' })
  lastActiveAt!: string;

  @ApiProperty({ description: 'True for the session this request was made with.' })
  current!: boolean;
}

export class OwnSessions {
  @ApiProperty({
    type: [OwnSession],
    description:
      'The live sessions, the current one first, then the most recently used (50 at most).',
  })
  items!: OwnSession[];
}

export class OtherSessionsSignedOut {
  @ApiProperty({ enum: ['other-sessions-signed-out'] })
  code!: 'other-sessions-signed-out';

  @ApiProperty({ description: 'How many sessions were ended; 0 when this was the only one.' })
  revokedSessions!: number;
}
