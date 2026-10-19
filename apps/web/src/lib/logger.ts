/**
 * The single logging seam of the SPA. Shipping code must never call `console.*`
 * directly (lint-enforced); everything funnels through here so that production
 * builds can drop debug noise and future telemetry can be added in one place.
 */
/* eslint-disable no-console -- this module is the only sanctioned console wrapper */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly at: string;
}

const isDev = import.meta.env.DEV;
const BUFFER_LIMIT = 100;
const buffer: LogRecord[] = [];

function record(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry: LogRecord = { level, message, context, at: new Date().toISOString() };
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) {
    buffer.shift();
  }
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (level === 'debug' && !isDev) {
    return;
  }
  record(level, message, context);
  const args: unknown[] = context === undefined ? [message] : [message, context];
  switch (level) {
    case 'debug':
      console.debug('[saman]', ...args);
      break;
    case 'info':
      console.info('[saman]', ...args);
      break;
    case 'warn':
      console.warn('[saman]', ...args);
      break;
    case 'error':
      console.error('[saman]', ...args);
      break;
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>): void => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>): void => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>): void => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>): void => emit('error', message, context),
  /** Recent records for support/debug screens; never contains secrets. */
  recent: (): readonly LogRecord[] => [...buffer],
};
