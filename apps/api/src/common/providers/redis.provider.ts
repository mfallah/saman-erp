import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';

/** DI token for the ioredis client (cache, rate limit, queues, OTP counters). */
export const REDIS = Symbol.for('saman.redis');

/**
 * Redis is a cache/queue, never a source of truth (`ARCHITECTURE.md` §3):
 * connection is lazy and failures degrade features instead of crashing writes.
 */
@Injectable()
export class RedisProvider implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5000,
      keyPrefix: config.redisPrefix,
      ...(config.redisPassword !== undefined ? { password: config.redisPassword } : {}),
      ...(config.redisTls ? { tls: { rejectUnauthorized: true } } : {}),
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });
    // Errors are surfaced by readiness/metrics; an unhandled 'error' event would crash the process.
    this.client.on('error', () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
    }
  }
}
