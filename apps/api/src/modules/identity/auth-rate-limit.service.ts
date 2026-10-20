import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { REDIS } from '../../common/providers/redis.provider';

interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfter: number;
}

/**
 * Sliding-window rate limiting for auth entrypoints (`API.md` §1.12).
 * Redis is the hot counter; when Redis is unavailable the limiter degrades to a
 * per-process in-memory window instead of failing the request
 * (`ARCHITECTURE.md` §13 — Redis outage must not block logins entirely).
 */
@Injectable()
export class AuthRateLimitService {
  private readonly fallback = new Map<string, WindowEntry>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async consume(
    bucket: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    if (!this.config.rateLimitEnabled) return { allowed: true, retryAfter: 0 };
    const key = `${this.config.redisPrefix}rl:${bucket}:${identifier}`;
    try {
      const results = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
      const incremented = results?.[0]?.[1];
      const count = typeof incremented === 'number' ? incremented : Number(incremented ?? 0);
      if (count > limit) {
        const ttl = await this.redis.ttl(key);
        return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
      }
      return { allowed: true, retryAfter: 0 };
    } catch {
      return this.consumeFallback(key, limit, windowSeconds);
    }
  }

  private consumeFallback(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    const entry = this.fallback.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.fallback.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }
}
