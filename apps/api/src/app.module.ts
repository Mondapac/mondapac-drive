import { Module } from '@nestjs/common';
import { DeliveryModule } from './modules/delivery/delivery.module.js';
import { HealthController } from './platform/health/health.controller.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [PlatformModule, DeliveryModule],
  controllers: [HealthController],
})
export class AppModule {}
