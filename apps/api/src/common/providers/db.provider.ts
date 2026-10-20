import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import postgres from 'postgres';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { DB } from '../contracts';

export type Database = ReturnType<typeof postgres>;

/**
 * Single postgres.js pool per process (`ARCHITECTURE.md` §6).
 *
 * Connections are lazy: constructing the provider does not open sockets, so the
 * process boots even when the database is briefly unavailable (readiness reports
 * it, traffic is drained). The pool is closed on graceful shutdown via
 * `app.enableShutdownHooks()`.
 */
@Injectable()
export class DatabaseProvider implements OnModuleDestroy {
  readonly client: Database;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = postgres(config.databaseUrl, {
      max: config.dbPoolMax,
      idle_timeout: Math.max(1, Math.floor(config.dbIdleTimeoutMs / 1000)),
      connect_timeout: 10,
      ...(config.dbSsl ? { ssl: { rejectUnauthorized: true } } : { ssl: false as const }),
      connection: { application_name: 'saman-erp-api' },
      onnotice: () => undefined,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

/** Re-exported so feature modules keep importing the token from `contracts`. */
export { DB };
