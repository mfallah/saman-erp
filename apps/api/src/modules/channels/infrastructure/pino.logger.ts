/**
 * Pino-backed logger with a redaction policy that covers credentials, cookies,
 * signature headers and phone numbers. Adapter code must log ids only; this is
 * the last line of defence.
 */
import pino from 'pino';

import type { AppLogger, LogFields } from '../ports/logger.port';

export function createPinoLogger(level = process.env.LOG_LEVEL ?? 'info'): AppLogger {
  const base = pino({
    level,
    base: { service: 'saman-api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers.apikey',
        'req.headers["x-signature"]',
        '*.password',
        '*.secret',
        '*.token',
        '*.apiKey',
        '*.api_key',
        '*.clientSecret',
        '*.client_secret',
        '*.ciphertext',
        '*.mobile',
        '*.phone',
      ],
      censor: '[redacted]',
    },
  });

  const wrap = (instance: pino.Logger): AppLogger => ({
    debug(fields: LogFields, message: string) {
      instance.debug(fields, message);
    },
    info(fields: LogFields, message: string) {
      instance.info(fields, message);
    },
    warn(fields: LogFields, message: string) {
      instance.warn(fields, message);
    },
    error(fields: LogFields, message: string) {
      instance.error(fields, message);
    },
    child(bindings: LogFields) {
      return wrap(instance.child(bindings));
    },
  });

  return wrap(base);
}
