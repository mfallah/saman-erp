import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';

/** Prometheus scrape endpoint; the service itself is provided by `PlatformModule`. */
@Module({
  controllers: [MetricsController],
})
export class MetricsModule {}
