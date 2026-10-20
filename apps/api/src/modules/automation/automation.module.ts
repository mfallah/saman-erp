import { Module } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import { createAutomationLogger, AUTOMATION_LOGGER, type Logger } from './infrastructure/logger';
import { SqlAutomationRepository } from './repositories/automation.repository';
import { AutomationService } from './services/automation.service';

@Module({
  providers: [
    { provide: AUTOMATION_LOGGER, useFactory: (): Logger => createAutomationLogger() },
    {
      provide: SqlAutomationRepository,
      useFactory: (db: Db): SqlAutomationRepository => new SqlAutomationRepository(db),
      inject: [DB],
    },
    {
      provide: AutomationService,
      useFactory: (
        repository: SqlAutomationRepository,
        logger: Logger,
      ): AutomationService => new AutomationService({ repository, logger }),
      inject: [SqlAutomationRepository, AUTOMATION_LOGGER],
    },
  ],
  exports: [AutomationService, SqlAutomationRepository],
})
export class AutomationModule {}
