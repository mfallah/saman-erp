import pino, { type Logger, type LoggerOptions } from 'pino';
import pinoHttp from 'pino-http';

import type { AppConfig } from '../../config/env.schema';

/**
 * Structural log redaction (`ARCHITECTURE.md` §12, `API.md` §1.16): credentials,
 * cookies, OTPs, tokens and password fields never reach stdout, nests included.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-step-up-token"]',
  'res.headers["set-cookie"]',
  'authorization',
  'cookie',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'otp',
  'otpCode',
  'otpHash',
  'refreshToken',
  'accessToken',
  'token',
  'secret',
  'clientSecret',
  'apiKey',
  'encryptionKey',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
];

export interface LoggerOptionsInput {
  level: LogLevel;
  appName: string;
  appEnv: AppEnv;
  nodeEnv: NodeEnv;
  service?: string;
}

type LogLevel = AppConfig['logLevel'];
type AppEnv = AppConfig['appEnv'];
type NodeEnv = AppConfig['nodeEnv'];

/** Builds the shared pino logger (JSON to stdout, ISO timestamps, redaction). */
export function createLogger(config: {
  logLevel: LogLevel;
  appName: string;
  appEnv: AppEnv;
  nodeEnv: NodeEnv;
  service?: string;
}): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: {
      service: config.service ?? 'saman-api',
      app: config.appName,
      env: config.appEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };
  return pino(options);
}

/**
 * HTTP request logger built on pino-http. The API currently logs requests through
 * `RequestLoggingInterceptor` (single logger, no Fastify logger duplication);
 * this factory is used by the worker/other entrypoints and kept as the standard
 * HTTP logging seam.
 */
export function createHttpLogger(logger: Logger, config: { appEnv: AppEnv }) {
  return pinoHttp({
    logger,
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
    customLogLevel: (_request, response, error) => {
      if (error !== undefined || response.statusCode >= 500) return 'error';
      if (response.statusCode >= 400) return 'warn';
      return 'info';
    },
    quietReqLogger: config.appEnv === 'production',
  });
}
