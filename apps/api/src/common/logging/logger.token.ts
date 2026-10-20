import type { Logger } from 'pino';

/** DI token for the process-wide pino logger. */
export const LOGGER = Symbol.for('saman.logger');

export type AppLogger = Logger;
