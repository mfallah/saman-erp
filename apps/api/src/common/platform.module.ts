import { Global, Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import {
  AUDIT,
  CRYPTO,
  DB,
  EVENT_BUS,
  TENANT,
} from './contracts';
import { AuditWriter } from './providers/audit.provider';
import { CryptoService } from './providers/crypto.service';
import { DatabaseProvider } from './providers/db.provider';
import { OutboxWriter } from './providers/outbox.provider';
import { REDIS, RedisProvider } from './providers/redis.provider';
import { TenantService } from './tenant/tenant.service';
import { MetricsService } from '../modules/metrics/metrics.service';

/**
 * Global platform seam (`contracts.ts`, `ARCHITECTURE.md` §5).
 *
 * Feature modules inject the stable tokens — `DB`, `AUDIT`, `EVENT_BUS`,
 * `CRYPTO`, `TENANT` — and never instantiate infrastructure themselves:
 * - `DB`: postgres.js pool (transactions via `db.transaction(tx => …)`).
 * - `AUDIT`: append-only `erp.audit_logs` writer, caller's transaction.
 * - `EVENT_BUS`: transactional outbox writer into `erp.outbox_events`.
 * - `CRYPTO`: AES-256-GCM versioned envelope for channel credentials.
 * - `TENANT`: AsyncLocalStorage accessor for the resolved org/actor context.
 * - `REDIS`: ioredis client (cache/rate limit/queues) — platform-only token.
 * - `MetricsService`: Prometheus registry shared by the metrics interceptor.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    DatabaseProvider,
    { provide: DB, useFactory: (provider: DatabaseProvider) => provider.client, inject: [DatabaseProvider] },
    RedisProvider,
    { provide: REDIS, useFactory: (provider: RedisProvider) => provider.client, inject: [RedisProvider] },
    AuditWriter,
    { provide: AUDIT, useExisting: AuditWriter },
    OutboxWriter,
    { provide: EVENT_BUS, useExisting: OutboxWriter },
    CryptoService,
    { provide: CRYPTO, useExisting: CryptoService },
    TenantService,
    { provide: TENANT, useExisting: TenantService },
    MetricsService,
  ],
  exports: [
    DB,
    REDIS,
    AUDIT,
    EVENT_BUS,
    CRYPTO,
    TENANT,
    MetricsService,
    DatabaseProvider,
    RedisProvider,
  ],
})
export class PlatformModule {}
