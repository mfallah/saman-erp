/**
 * Integrations module: Limo SMS client, SMS budget/limits, OTP challenges.
 * Provider mode is `SMS_MODE=mock|limo`; mock is refused in production.
 */
import { Module } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import { createIntegrationKeyValue, INTEGRATION_KV, type KeyValueStore } from './infrastructure/key-value';
import {
  createIntegrationLogger,
  INTEGRATION_LOGGER,
  type Logger,
} from './infrastructure/logger';
import { LimoSmsClient } from './limo/limo.client';
import type { SmsMode } from './limo/limo.constants';
import { SqlSmsRepository } from './sms/sms.repository';
import { SmsBudgetService } from './sms/sms-budget.service';
import { SmsService, type SmsRuntimeConfig } from './sms/sms.service';
import { SqlOtpRepository } from './otp/otp.repository';
import { OtpService } from './otp/otp.service';

@Module({
  providers: [
    { provide: INTEGRATION_LOGGER, useFactory: (): Logger => createIntegrationLogger() },
    {
      provide: INTEGRATION_KV,
      useFactory: (logger: Logger): KeyValueStore => createIntegrationKeyValue(logger),
      inject: [INTEGRATION_LOGGER],
    },
    {
      provide: LimoSmsClient,
      useFactory: (logger: Logger): LimoSmsClient =>
        new LimoSmsClient({
          mode: (process.env.SMS_MODE === 'limo' ? 'limo' : 'mock') as SmsMode,
          apiKey: process.env.LIMO_API_KEY,
          appEnv: process.env.APP_ENV ?? 'development',
          logger,
        }),
      inject: [INTEGRATION_LOGGER],
    },
    {
      provide: SmsBudgetService,
      useFactory: (store: KeyValueStore): SmsBudgetService => new SmsBudgetService(store),
      inject: [INTEGRATION_KV],
    },
    {
      provide: SqlSmsRepository,
      useFactory: (db: Db): SqlSmsRepository => new SqlSmsRepository(db),
      inject: [DB],
    },
    {
      provide: SmsService,
      useFactory: (
        client: LimoSmsClient,
        budget: SmsBudgetService,
        repository: SqlSmsRepository,
        store: KeyValueStore,
        logger: Logger,
      ): SmsService => {
        const pattern = Number(process.env.LIMO_OTP_PATTERN_ID ?? '');
        const config: SmsRuntimeConfig = {
          mode: (process.env.SMS_MODE === 'limo' ? 'limo' : 'mock') as SmsMode,
          appEnv: process.env.APP_ENV ?? 'development',
          senderNumber: process.env.LIMO_SENDER_NUMBER ?? '',
          otpPatternId: Number.isInteger(pattern) && pattern > 0 ? pattern : null,
          unitPriceIrr: Number(process.env.SMS_UNIT_PRICE_IRR ?? 1500),
          voiceUnitPriceIrr: Number(process.env.OTP_VOICE_UNIT_PRICE_IRR ?? 5000),
          ipHourlyLimit: Number(process.env.SMS_IP_HOURLY_LIMIT ?? 30),
        };
        return new SmsService({ client, budget, repository, store, logger, config });
      },
      inject: [LimoSmsClient, SmsBudgetService, SqlSmsRepository, INTEGRATION_KV, INTEGRATION_LOGGER],
    },
    {
      provide: SqlOtpRepository,
      useFactory: (db: Db): SqlOtpRepository => new SqlOtpRepository(db),
      inject: [DB],
    },
    {
      provide: OtpService,
      useFactory: (
        repository: SqlOtpRepository,
        sms: SmsService,
        logger: Logger,
      ): OtpService =>
        new OtpService({
          repository,
          sms,
          logger,
          options: {
            pepper: process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me-please',
            appEnv: process.env.APP_ENV ?? 'development',
          },
        }),
      inject: [SqlOtpRepository, SmsService, INTEGRATION_LOGGER],
    },
  ],
  exports: [
    LimoSmsClient,
    SmsService,
    SmsBudgetService,
    OtpService,
    SqlSmsRepository,
    SqlOtpRepository,
    INTEGRATION_KV,
  ],
})
export class IntegrationsModule {}
