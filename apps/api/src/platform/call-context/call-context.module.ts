import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RoutePopulationCheck } from './route-population.check';

/**
 * The start-up check of the route populations (identity design 6.4): every controller of the
 * application, found through `DiscoveryService`, is checked before the application serves.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [RoutePopulationCheck],
})
export class CallContextModule {}
