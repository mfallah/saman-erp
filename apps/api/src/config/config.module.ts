import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, loadConfig, type AppConfig } from './env.schema';

/**
 * Global typed configuration module.
 *
 * `loadConfig()` validates every environment variable (including `*_FILE`
 * indirection) and enforces production boot-guards exactly once per process.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
