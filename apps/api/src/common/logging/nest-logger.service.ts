import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/** Bridges Nest's `LoggerService` to the pino logger (no `console` in the API). */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    const context = optionalParams.find((param): param is string => typeof param === 'string');
    if (message instanceof Error) {
      this.logger[level]({ err: message, context }, message.message);
      return;
    }
    if (typeof message === 'string') {
      this.logger[level]({ context }, message);
      return;
    }
    this.logger[level]({ context, detail: message }, 'log');
  }
}
