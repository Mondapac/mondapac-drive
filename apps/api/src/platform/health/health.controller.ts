import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import { NoMarketContext } from '../market-context/no-market-context.decorator';
import { DatabaseProbe } from '../persistence/database-probe';
import { HealthResponse } from './health-response';

// This file may import the market exemption (rule 6 of design 8.2), so it exports the
// controller only (asserted in apps/api/test/boundaries.spec.ts).

/** Platform probes. Exempt from Market resolution (ADR-0015 decision 3): no x-market-id. */
@ApiTags('platform')
@NoMarketContext()
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  /** Liveness: the process is up and serving HTTP. It checks no dependencies. */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ type: HealthResponse })
  check(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: the process can reach the database and may receive traffic. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (checks the database)' })
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  async ready(): Promise<HealthResponse> {
    try {
      await this.database.ping();
    } catch (error) {
      // The cause goes to the log only; the response must not leak connection details.
      this.logger.error({ err: error }, 'readiness check failed: database unreachable');
      throw new ServiceUnavailableException('database unavailable');
    }
    return { status: 'ok' };
  }
}
