import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { AppConfigModule } from '../../config/config.module';
import { createLogger } from './logger';
import { LOGGER } from './logger.token';

/**
 * Provides the process logger through the `LOGGER` token (single pino instance;
 * Fastify's own request logger is disabled so every line shares redaction).
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: LOGGER,
      useFactory: (config: AppConfig) => createLogger(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [LOGGER],
})
export class LoggingModule {}
