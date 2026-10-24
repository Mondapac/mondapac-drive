import { ApiProperty } from '@nestjs/swagger';

/** The body of both health probes. */
export class HealthResponse {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';
}
