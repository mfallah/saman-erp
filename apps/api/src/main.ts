import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';

import { AppModule } from './app.module';
import { configureApp, JSON_BODY_LIMIT_BYTES } from './bootstrap';
import { registerWebUi } from './common/web-ui';
import { DB, type Db } from './common/contracts';
import { loadConfig, type AppConfig } from './config/env.schema';
import { LOGGER, type AppLogger } from './common/logging/logger.token';
import { PinoNestLogger } from './common/logging/nest-logger.service';
import { getAppVersion } from './common/version';
import { ChannelSyncService } from './modules/channels/services/channel-sync.service';
import { startAutoSyncScheduler } from './modules/channels/services/auto-sync.scheduler';

let stopAutoSync: (() => void) | null = null;

function shutdown(logger: AppLogger, signal: string): void {
  stopAutoSync?.();
  stopAutoSync = null;
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

  // The admin SPA is bundled into the image; serve it from the same origin.
  const webRoot = process.env['WEB_DIST'] ?? '/app/web-dist';
  const served = registerWebUi(app.getHttpAdapter().getInstance(), webRoot);
  if (served) logger.info({ webRoot }, 'web_ui_registered');

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

  // In-process order-pull loop (no queue, no new deps); a no-op when disabled.
  stopAutoSync = startAutoSyncScheduler({
    db: app.get<Db>(DB),
    sync: app.get(ChannelSyncService),
    logger,
    enabled: config.autoSyncEnabled,
  });
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Boot failures happen before DI/logging is available; stderr keeps them visible.
  process.stderr.write(`Fatal boot error: ${message}\n`);
  process.exitCode = 1;
});
