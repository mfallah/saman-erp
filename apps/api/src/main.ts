import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';

import { AppModule } from './app.module';
import { configureApp, JSON_BODY_LIMIT_BYTES } from './bootstrap';
import { loadConfig, type AppConfig } from './config/env.schema';
import { LOGGER, type AppLogger } from './common/logging/logger.token';
import { PinoNestLogger } from './common/logging/nest-logger.service';
import { getAppVersion } from './common/version';

function shutdown(logger: AppLogger, signal: string): void {
  logger.info({ signal }, 'shutdown_started');
}

async function bootstrap(): Promise<void> {
  const config: AppConfig = loadConfig();
  const options: FastifyServerOptions = {
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    trustProxy: config.trustProxy,
    // Request logging goes through Nest's single pino logger, not Fastify's own.
    logger: false,
  };
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(options),
    { bufferLogs: true },
  );
  const logger = app.get<AppLogger>(LOGGER);
  app.useLogger(new PinoNestLogger(logger));
  app.flushLogs();

  await configureApp(app, config, logger);
  app.enableShutdownHooks(); // closes the postgres pool and redis client (onModuleDestroy)
  process.once('SIGTERM', () => shutdown(logger, 'SIGTERM'));
  process.once('SIGINT', () => shutdown(logger, 'SIGINT'));

  await app.listen(config.port, config.host);
  const version = getAppVersion();
  logger.info(
    {
      host: config.host,
      port: config.port,
      env: config.appEnv,
      basePath: `/${config.apiPrefix}/${config.apiVersion}`,
      version: version.version,
      commit: config.gitSha,
    },
    'api_started',
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Boot failures happen before DI/logging is available; stderr keeps them visible.
  process.stderr.write(`Fatal boot error: ${message}\n`);
  process.exitCode = 1;
});
