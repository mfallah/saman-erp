import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Liveness/readiness/version probes (DB/Redis tokens come from `PlatformModule`). */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
