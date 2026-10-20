/**
 * Redis binding for `KeyValueStore` (ioredis, lazy). Falls back to in-memory
 * when `REDIS_URL` is absent so unit tests and a single-process dev run work.
 */
import Redis from 'ioredis';

import type { KeyValueStore } from '../ports/key-value.port';
import { InMemoryKeyValueStore } from '../ports/key-value.port';
import type { AppLogger } from '../ports/logger.port';

class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.redis.set(key, value);
    } else {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const value = await this.redis.incrby(key, amount);
    if (ttlSeconds !== undefined && value === amount) {
      await this.redis.expire(key, ttlSeconds);
    }
    return value;
  }
}

export function createKeyValueStore(logger: AppLogger): KeyValueStore {
  const url = process.env.REDIS_URL;
  if (url === undefined || url.trim().length === 0) {
    logger.warn({}, 'REDIS_URL not set; using in-memory key/value store (dev/test only)');
    return new InMemoryKeyValueStore();
  }
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });
  redis.on('error', (error: unknown) => {
    logger.error({ error: error instanceof Error ? error.message : 'redis_error' }, 'redis error');
  });
  return new RedisKeyValueStore(redis);
}
