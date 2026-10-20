/** Reporting module: registry with per-report permissions, runs, dashboards, exports. */
import { Module } from '@nestjs/common';
import { ReportingRepository } from './reporting.repository';
import { ReportingReadModel } from './read-model.repository';
import { ReportingService } from './reporting.service';
import { ReportingController } from './controllers/reporting.controller';

@Module({
  controllers: [ReportingController],
  providers: [ReportingRepository, ReportingReadModel, ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}