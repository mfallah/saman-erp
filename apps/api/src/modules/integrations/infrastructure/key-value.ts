/** Redis-backed counters/values with an in-memory fallback (dev, tests). */
import Redis from 'ioredis';

import type { Logger } from './logger';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number>;
}

export const INTEGRATION_KV = Symbol.for('saman.integration-kv');

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

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const current = Number((await this.get(key)) ?? '0');
    const next = current + amount;
    const previous = this.entries.get(key);
    this.entries.set(key, {
      value: String(next),
      expiresAt:
        previous?.expiresAt ?? (ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000),
    });
    return next;
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
  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const value = await this.redis.incrby(key, amount);
    if (ttlSeconds !== undefined && value === amount) await this.redis.expire(key, ttlSeconds);
    return value;
  }
}

export function createIntegrationKeyValue(logger: Logger): KeyValueStore {
  const url = process.env.REDIS_URL;
  if (url === undefined || url.trim().length === 0) {
    logger.warn({}, 'REDIS_URL not set; SMS/OTP budgets use in-memory counters (dev only)');
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
