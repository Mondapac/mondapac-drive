import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class FieldProblemBody {
  @ApiProperty({ example: 'email' })
  path!: string;

  @ApiProperty({ enum: ['required', 'type', 'format', 'length', 'unknown-field'] })
  code!: string;
}

class ErrorDetailsBody {
  @ApiPropertyOptional({ type: [FieldProblemBody], description: 'validation.failed' })
  fields?: FieldProblemBody[];

  @ApiPropertyOptional({
    enum: ['length', 'common', 'contains-identity'],
    description: 'password.rejected',
  })
  rule?: string;

  @ApiPropertyOptional({ description: 'request.busy and request.throttled' })
  retryAfterSeconds?: number;
}

/** The error format of identity design 5.2: `{ statusCode, code, details? }`, codes only. */
export class ApiErrorBody {
  @ApiProperty()
  statusCode!: number;

  @ApiProperty({
    enum: [
      'validation.failed',
      'password.rejected',
      'password.current-incorrect',
      'request.body-unsupported',
      'request.throttled',
      'request.busy',
      'request.csrf',
      'session.invalid',
      'credentials.invalid',
      'email-verification-required',
      'account.disabled',
      'link.rejected',
      'access.unauthenticated',
      'access.denied',
      'access.unavailable',
      'conflict.retry',
    ],
  })
  code!: string;

  @ApiPropertyOptional({ type: ErrorDetailsBody })
  details?: ErrorDetailsBody;
}

/** The answer of a sign-out. */
export class SignedOut {
  @ApiProperty({ enum: ['signed-out'] })
  code!: 'signed-out';
}
