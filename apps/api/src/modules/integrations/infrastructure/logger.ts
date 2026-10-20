import pino from 'pino';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

export const INTEGRATION_LOGGER = Symbol.for('saman.integration-logger');

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export function createIntegrationLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const logger = pino({
    level,
    base: { service: 'saman-api' },
    redact: {
      paths: ['*.mobile', '*.phone', '*.apiKey', '*.api_key', '*.token', '*.ciphertext'],
      censor: '[redacted]',
    },
  });
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
}
