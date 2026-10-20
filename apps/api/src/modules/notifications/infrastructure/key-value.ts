/** Small KV abstraction for notification dedupe (Redis in production). */
import Redis from 'ioredis';

import type { Logger } from './logger';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const NOTIFICATION_KV = Symbol.for('saman.notification-kv');

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number | null }>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000,
    });
  }
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}
  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) await this.redis.set(key, value);
    else await this.redis.set(key, value, 'EX', ttlSeconds);
  }
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export function createNotificationKeyValue(logger: Logger): KeyValueStore {
  const url = process.env.REDIS_URL;
  if (url === undefined || url.trim().length === 0) {
    logger.warn({}, 'REDIS_URL not set; notification dedupe uses in-memory store');
    return new InMemoryKeyValueStore();
  }
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });
  redis.on('error', (error: unknown) => {
    logger.error({ error: error instanceof Error ? error.message : 'redis_error' }, 'redis error');
  });
  return new RedisKeyValueStore(redis);
}
