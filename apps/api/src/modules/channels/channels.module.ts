/**
 * Channels module composition root.
 *
 * Every adapter gets its own HTTP client bound to its **own** declared host set,
 * so a Carexy credential can never be sent to a Digikala host (ADR-0006 rev. 4).
 */
import { Module } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import { createPinoLogger } from './infrastructure/pino.logger';
import { createKeyValueStore } from './infrastructure/redis.store';
import { PartnerHttpClient } from './infrastructure/partner-http.client';
import { TokenBucket } from './infrastructure/token-bucket';
import type { AppLogger } from './ports/logger.port';
import { LOGGER } from './ports/logger.port';
import { CHANNEL_ADAPTERS, type ChannelAdapter } from './ports/channel-adapter.port';
import { KEY_VALUE } from './channels.tokens';
import type { KeyValueStore } from './ports/key-value.port';
import { CAREXY_HOSTS } from './adapters/carexy/carexy.constants';
import { DIGIKALA_HOSTS } from './adapters/digikala/digikala.constants';
import { CarexyAdapter } from './adapters/carexy/carexy.adapter';
import { DigikalaAdapter } from './adapters/digikala/digikala.adapter';
import { MockAdapter } from './adapters/mock/mock.adapter';
import { SqlChannelApiCallRepository } from './repositories/channel-api-call.repository';
import { SqlChannelMappingRepository } from './repositories/channel-mapping.repository';
import { AdapterRegistry } from './services/adapter.registry';
import { ChannelAccountService } from './services/channel-accounts.service';
import { CHANNEL_PRICE_SOURCE_PROVIDER } from './services/channel-price-source.service';
import { ChannelMappingService } from './services/channel-mappings.service';
import { ChannelReconcilerService } from './services/channel-reconciler.service';
import { ChannelSyncService } from './services/channel-sync.service';
import { ChannelWebhookService } from './services/channel-webhook.service';
import { OutboundWebhookService } from './services/outbound-webhook.service';
import {
  ChannelWebhookController,
  WebhookHealthController,
} from './webhook/channel-webhook.controller';
import { ChannelsAdminController } from './admin/channels-admin.controller';
import { ChannelMappingsAdminController } from './admin/channel-mappings.controller';

@Module({
  controllers: [
    ChannelsAdminController,
    ChannelMappingsAdminController,
    ChannelWebhookController,
    WebhookHealthController,
  ],
  providers: [
    CHANNEL_PRICE_SOURCE_PROVIDER,
    { provide: LOGGER, useFactory: (): AppLogger => createPinoLogger() },
    {
      provide: KEY_VALUE,
      useFactory: (logger: AppLogger): KeyValueStore => createKeyValueStore(logger),
      inject: [LOGGER],
    },
    {
      provide: SqlChannelApiCallRepository,
      useFactory: (db: Db): SqlChannelApiCallRepository => new SqlChannelApiCallRepository(db),
      inject: [DB],
    },
    {
      provide: TokenBucket,
      useFactory: (store: KeyValueStore): TokenBucket =>
        new TokenBucket(store, {
          capacity: Number(process.env.CHANNEL_RATE_LIMIT_BURST ?? 10),
          refillPerSecond: Number(process.env.CHANNEL_RATE_LIMIT_PER_SECOND ?? 5),
        }),
      inject: [KEY_VALUE],
    },
    {
      provide: CarexyAdapter,
      useFactory: (
        db: Db,
        logger: AppLogger,
        apiCalls: SqlChannelApiCallRepository,
        bucket: TokenBucket,
      ): CarexyAdapter =>
        new CarexyAdapter({
          http: new PartnerHttpClient(
            { logger, apiCalls, rateLimiter: bucket, declaredHosts: CAREXY_HOSTS },
            { timeoutMs: 20_000, maxAttempts: 3 },
          ),
          mappings: new SqlChannelMappingRepository(db),
          logger,
        }),
      inject: [DB, LOGGER, SqlChannelApiCallRepository, TokenBucket],
    },
    {
      provide: DigikalaAdapter,
      useFactory: (
        db: Db,
        logger: AppLogger,
        apiCalls: SqlChannelApiCallRepository,
        bucket: TokenBucket,
        store: KeyValueStore,
      ): DigikalaAdapter =>
        new DigikalaAdapter({
          http: new PartnerHttpClient(
            { logger, apiCalls, rateLimiter: bucket, declaredHosts: DIGIKALA_HOSTS },
            { timeoutMs: 20_000, maxAttempts: 3 },
          ),
          store,
          logger,
        }),
      inject: [DB, LOGGER, SqlChannelApiCallRepository, TokenBucket, KEY_VALUE],
    },
    { provide: MockAdapter, useFactory: (): MockAdapter => new MockAdapter() },
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        carexy: CarexyAdapter,
        digikala: DigikalaAdapter,
        mock: MockAdapter,
      ): readonly ChannelAdapter[] => [carexy, digikala, mock],
      inject: [CarexyAdapter, DigikalaAdapter, MockAdapter],
    },
    AdapterRegistry,
    ChannelAccountService,
    ChannelMappingService,
    ChannelSyncService,
    ChannelReconcilerService,
    ChannelWebhookService,
    OutboundWebhookService,
  ],
  exports: [
    AdapterRegistry,
    ChannelAccountService,
    ChannelMappingService,
    ChannelSyncService,
    ChannelReconcilerService,
    ChannelWebhookService,
    OutboundWebhookService,
    CHANNEL_ADAPTERS,
    LOGGER,
    KEY_VALUE,
  ],
})
export class ChannelsModule {}
