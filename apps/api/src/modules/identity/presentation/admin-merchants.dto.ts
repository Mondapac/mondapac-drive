import { ApiProperty } from '@nestjs/swagger';

export class AdminCourierInviteRequest {
  @ApiProperty({ description: "The courier's address. Never logged, echoed or audited." })
  email!: string;
}

export class AdminCourierInvitationIssued {
  @ApiProperty({ enum: ['invitation.issued'] })
  code!: 'invitation.issued';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

export class AdminCreateMerchantRequest {
  @ApiProperty({ description: "The business's name, as operators see it.", maxLength: 100 })
  name!: string;
}

export class AdminMerchantCreated {
  @ApiProperty({ enum: ['merchant.created'] })
  code!: 'merchant.created';

  @ApiProperty({ format: 'uuid' })
  merchantId!: string;
}

export class AdminMerchantView {
  @ApiProperty({ format: 'uuid' })
  merchantId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['active', 'suspended'] })
  state!: 'active' | 'suspended';

  @ApiProperty({ format: 'date-time' })
  stateChangedAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminMerchantList {
  @ApiProperty({ type: [AdminMerchantView] })
  items!: AdminMerchantView[];
}

export class AdminMerchantStateChanged {
  @ApiProperty({
    enum: ['merchant.suspended', 'merchant.reinstated'],
    description: 'A suspension revoked every API key of the merchant.',
  })
  code!: 'merchant.suspended' | 'merchant.reinstated';

  @ApiProperty({ format: 'uuid' })
  merchantId!: string;
}

export class AdminIssueApiKeyRequest {
  @ApiProperty({ description: 'What the key is for ("marketplace production").', maxLength: 64 })
  label!: string;
}

export class AdminApiKeyIssued {
  @ApiProperty({ enum: ['api-key.issued'] })
  code!: 'api-key.issued';

  @ApiProperty({ format: 'uuid' })
  keyId!: string;

  @ApiProperty({
    description:
      'The key, shown this once: it is never stored (only its hash), so it cannot be shown again. ' +
      'Sent as `Authorization: Bearer <key>` on the delivery routes.',
  })
  key!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class AdminApiKeyView {
  @ApiProperty({ format: 'uuid' })
  keyId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Last used, to the minute.' })
  lastSeenAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class AdminApiKeyList {
  @ApiProperty({ type: [AdminApiKeyView] })
  items!: AdminApiKeyView[];
}

export class AdminApiKeyRevoked {
  @ApiProperty({ enum: ['api-key.revoked'] })
  code!: 'api-key.revoked';

  @ApiProperty({ format: 'uuid' })
  keyId!: string;
}
