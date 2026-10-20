import { Module } from '@nestjs/common';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import pino from 'pino';
import type Redis from 'ioredis';

import type { AppConfig} from '../../src/config/env.schema';
import { APP_CONFIG, loadConfig } from '../../src/config/env.schema';
import { DB } from '../../src/common/contracts';
import type { Database } from '../../src/common/providers/db.provider';
import { REDIS } from '../../src/common/providers/redis.provider';
import { LOGGER } from '../../src/common/logging/logger.token';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PermissionsGuard } from '../../src/common/guards/permissions.guard';
import { RequestLoggingInterceptor } from '../../src/common/interceptors/request-logging.interceptor';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { configureApp } from '../../src/bootstrap';
import { HealthController } from '../../src/modules/health/health.controller';
import { HealthService } from '../../src/modules/health/health.service';

/** Valid test environment: `loadConfig` defaults + test overrides (guards off). */
export function makeTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ APP_ENV: 'test', NODE_ENV: 'test', LOG_LEVEL: 'error', ...overrides });
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export function healthyDatabase(): Database {
  const query = (): Promise<Array<{ ok: number }>> => Promise.resolve([{ ok: 1 }]);
  return query as unknown as Database;
}

export function failingDatabase(): Database {
  const query = (): Promise<never> => Promise.reject(new Error('database down'));
  return query as unknown as Database;
}

export function healthyRedis(): Redis {
  return { ping: () => Promise.resolve('PONG') } as unknown as Redis;
}

export function failingRedis(): Redis {
  return { ping: () => Promise.reject(new Error('redis down')) } as unknown as Redis;
}

export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly url: string;
  readonly config: AppConfig;
}

/**
 * Boots the same global wiring as `main.ts` against a mocked platform (no real
 * DB/Redis) without `@nestjs/testing`: a runtime module class holds the mocks.
 */
export async function createTestApp(
  options: { db?: Database; redis?: Redis; config?: AppConfig } = {},
): Promise<TestApp> {
  const config = options.config ?? makeTestConfig();
  const mocks = {
    db: options.db ?? healthyDatabase(),
    redis: options.redis ?? healthyRedis(),
    logger: silentLogger(),
  };
  // Runtime module class holds the mocks; no @nestjs/testing dependency.
  class TestAppModule {}
  Module({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: APP_CONFIG, useValue: config },
      { provide: DB, useValue: mocks.db },
      { provide: REDIS, useValue: mocks.redis },
      { provide: LOGGER, useValue: mocks.logger },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    ],
  })(TestAppModule);

  const app = await NestFactory.create<NestFastifyApplication>(TestAppModule, new FastifyAdapter(), {
    logger: false,
  });
  await configureApp(app, config, mocks.logger);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { app, url, config };
}
