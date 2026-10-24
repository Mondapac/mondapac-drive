import { Global, Module } from '@nestjs/common';
import { MarketContextFactory } from './market-context.factory';
import { PLATFORM_TENANT_ID, TENANT_ID } from './tenant';

/**
 * The Market context of requests, jobs and events (platform-foundations 5.1). Global, like
 * the other platform runtime modules; it exports the factory only. MarketContextGuard is
 * registered by AppModule in its APP_GUARD list.
 */
@Global()
@Module({
  providers: [MarketContextFactory, { provide: TENANT_ID, useValue: PLATFORM_TENANT_ID }],
  exports: [MarketContextFactory],
})
export class MarketContextModule {}
