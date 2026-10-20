import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { DB } from '../../common/contracts';
import type { Database } from '../../common/providers/db.provider';
import { REDIS } from '../../common/providers/redis.provider';
import type Redis from 'ioredis';

/** Readiness dependency status. `skipped` = dependency not wired in this phase. */
export interface DependencyCheck {
  readonly status: 'up' | 'down' | 'skipped';
  readonly latencyMs?: number;
  readonly reason?: string;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly checks: {
    readonly db: DependencyCheck;
    readonly redis: DependencyCheck;
    readonly s3: DependencyCheck;
  };
  readonly timestamp: string;
}

export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly timestamp: string;
}

export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  readonly schemaVersion: string;
  readonly env: string;
  readonly commit: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

const READINESS_TIMEOUT_MS = 1500;
const PACKAGE_MANIFEST_PATH = join(__dirname, '..', '..', '..', 'package.json');

function readManifest(): PackageManifest {
  try {
    const raw = readFileSync(PACKAGE_MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return {};
  }
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('dependency_timeout')), milliseconds);
      timer.unref();
    });
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Liveness/readiness/version probes (`API.md` §4.19, `ARCHITECTURE.md` §12).
 * Dependencies are pinged with a hard timeout so a hung dependency turns into a
 * fast `503` for the load balancer instead of piling up requests.
 */
@Injectable()
export class HealthService {
  private readonly manifest = readManifest();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  live(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  version(): BuildInfo {
    return {
      name: this.manifest.name ?? 'saman-api',
      version: this.manifest.version ?? '0.0.0',
      schemaVersion: process.env['SCHEMA_VERSION'] ?? 'unmanaged',
      env: this.config.appEnv,
      commit: this.config.gitSha,
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const [db, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    // S3 readiness is wired with the files module; it is reported explicitly as
    // skipped instead of pretending the dependency is healthy.
    const s3: DependencyCheck = { status: 'skipped', reason: 'files_module_pending' };
    const required = [db, redis];
    return {
      status: required.every((check) => check.status === 'up') ? 'ok' : 'degraded',
      checks: { db, redis, s3 },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    const startedAt = process.hrtime.bigint();
    try {
      await withTimeout(this.db`select 1 as ok`, READINESS_TIMEOUT_MS);
      return { status: 'up', latencyMs: elapsedMs(startedAt) };
    } catch {
      return { status: 'down', latencyMs: elapsedMs(startedAt), reason: 'database_unreachable' };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    const startedAt = process.hrtime.bigint();
    try {
      await withTimeout(this.redis.ping(), READINESS_TIMEOUT_MS);
      return { status: 'up', latencyMs: elapsedMs(startedAt) };
    } catch {
      return { status: 'down', latencyMs: elapsedMs(startedAt), reason: 'redis_unreachable' };
    }
  }
}

function elapsedMs(startedAt: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 100_000) / 10;
}
