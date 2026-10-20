/** Structured logger port (pino in production, silent/no-op in tests). */
export interface LogFields {
  [key: string]: unknown;
}

export interface AppLogger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  child(bindings: LogFields): AppLogger;
}

export const LOGGER = Symbol.for('saman.logger');

/** Test/CLI logger that never writes secrets or noise. */
export class SilentLogger implements AppLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): AppLogger {
    return this;
  }
}
