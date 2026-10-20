/**
 * Worker entrypoint — Nest application context, **no HTTP server**.
 *
 * `pnpm --filter @saman/api start:worker` (or `node dist/worker.js`) runs the
 * outbox dispatcher, channel sync, notifications, maintenance and report export
 * processors. SIGTERM/SIGINT drain in-flight work and close DB/Redis handles.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import pino from 'pino';

import { WorkerModule } from './workers/worker.module';
import { WorkerRuntime } from './workers/runtime';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'saman-worker', pid: process.pid },
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  const runtime = app.get(WorkerRuntime);
  await runtime.start();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down worker');
    const timeout = setTimeout(() => {
      logger.error({ signal }, 'graceful shutdown timed out');
      process.exit(1);
    }, 30_000);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
      logger.info({ signal }, 'worker stopped');
      process.exit(exitCode);
    } catch (error) {
      clearTimeout(timeout);
      logger.error(
        { error: error instanceof Error ? error.message : 'shutdown_failed' },
        'worker shutdown failed',
      );
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('uncaughtException', (error) => {
    logger.fatal({ error: error.message }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    logger.fatal(
      { error: reason instanceof Error ? reason.message : 'unhandled_rejection' },
      'unhandled rejection',
    );
    void shutdown('unhandledRejection', 1);
  });

  logger.info({ pid: process.pid, env: process.env.APP_ENV ?? 'development' }, 'worker booted');
}

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    { error: error instanceof Error ? error.message : 'bootstrap_failed' },
    'worker failed to start',
  );
  process.exit(1);
});
