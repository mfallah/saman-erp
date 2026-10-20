/**
 * SMS application service: Limo client + daily budget + per-mobile/IP limits +
 * `erp.sms_messages` audit. Never logs a full mobile number or message.
 */
import { createHash } from 'node:crypto';

import { AppError } from '@saman/shared';
import type { SmsMode } from '../limo/limo.constants';
import {
  DEFAULT_SMS_UNIT_PRICE_IRR,
  OTP_RESENDS_PER_10_MIN,
  OTP_SENDS_PER_HOUR,
  VOICE_OTP_PER_DAY,
} from '../limo/limo.constants';
import { LimoError } from '../limo/limo.errors';
import type { LimoSmsClient} from '../limo/limo.client';
import { estimateSmsSegments } from '../limo/limo.client';
import type { KeyValueStore } from '../infrastructure/key-value';
import type { Logger } from '../infrastructure/logger';
import type { SmsRepositoryPort } from './sms.repository';
import type { BudgetReservation, SmsBudgetService } from './sms-budget.service';

export interface SmsRuntimeConfig {
  readonly mode: SmsMode;
  readonly appEnv: string;
  readonly senderNumber: string;
  readonly otpPatternId: number | null;
  readonly unitPriceIrr: number;
  readonly voiceUnitPriceIrr: number;
  readonly ipHourlyLimit: number;
}

export interface SendOtpInput {
  readonly organizationId: string;
  readonly userId: string | null;
  readonly mobile: string;
  readonly code: string;
  readonly purpose: string;
  readonly ip?: string;
  readonly templateId?: string | null;
}

function phoneKey(mobile: string): string {
  return createHash('sha256').update(mobile).digest('hex').slice(0, 32);
}

function maskMobile(mobile: string): string {
  return mobile.length >= 8 ? `${mobile.slice(0, 4)}***${mobile.slice(-4)}` : '***';
}

export class SmsService {
  constructor(
    private readonly deps: {
      readonly client: LimoSmsClient;
      readonly budget: SmsBudgetService;
      readonly repository: SmsRepositoryPort;
      readonly store: KeyValueStore;
      readonly logger: Logger;
      readonly config: SmsRuntimeConfig;
    },
  ) {}

  get mode(): SmsMode {
    return this.deps.config.mode;
  }

  async sendOtp(input: SendOtpInput): Promise<{
    smsMessageId: string;
    providerMessageId: string | null;
    costAmount: number;
  }> {
    await this.enforceLimits(input.mobile, input.ip, 'otp');
    if (this.deps.config.otpPatternId === null) {
      throw new AppError('NOT_IMPLEMENTED', {
        message: 'الگوی پیامک OTP تنظیم نشده است.',
        messageKey: 'error.otp_pattern_missing',
      });
    }
    const estimate = this.deps.config.unitPriceIrr;
    const reservation = await this.deps.budget.reserve(input.organizationId, estimate, 'sms');
    try {
      const result = await this.deps.client.sendPattern({
        otpId: this.deps.config.otpPatternId,
        replaceTokens: [input.code],
        mobile: input.mobile,
        send: true,
      });
      await this.deps.budget.reconcile(reservation, result.totalAmount);
      const cost = result.totalAmount ?? estimate;
      const smsMessageId = await this.deps.repository.insert({
        organizationId: input.organizationId,
        userId: input.userId,
        templateId: input.templateId ?? null,
        mobile: input.mobile,
        message: `OTP pattern #${this.deps.config.otpPatternId}`,
        provider: result.mock ? 'mock' : 'limo_sms',
        providerMessageId: result.messageIds[0] ?? null,
        purpose: input.purpose,
        status: 'sent',
        costAmount: cost,
        attempts: 1,
        lastError: null,
      });
      this.deps.logger.info(
        { smsMessageId, mobile: maskMobile(input.mobile), purpose: input.purpose, cost },
        'otp sms sent',
      );
      return {
        smsMessageId,
        providerMessageId: result.messageIds[0] ?? null,
        costAmount: cost,
      };
    } catch (error) {
      await this.deps.budget.release(reservation);
      await this.recordFailure(input, error);
      throw this.toAppError(error);
    }
  }

  async sendVoiceOtp(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    code: string;
    purpose: string;
  }): Promise<{ smsMessageId: string; providerMessageId: string | null }> {
    const voiceKey = `otp:voice:${input.organizationId}:${phoneKey(input.mobile)}:${new Date()
      .toISOString()
      .slice(0, 10)}`;
    const count = await this.deps.store.incrBy(voiceKey, 1, 24 * 60 * 60);
    if (count > VOICE_OTP_PER_DAY) {
      throw new AppError('RATE_LIMITED', {
        message: 'سقف تماس صوتی OTP برای این شماره در امروز تکمیل شده است.',
        retryAfter: 3600,
      });
    }
    const reservation = await this.deps.budget.reserve(
      input.organizationId,
      this.deps.config.voiceUnitPriceIrr,
      'voice',
    );
    try {
      const result = await this.deps.client.sendVoiceOtp({
        phoneNumber: input.mobile,
        generateCode: input.code,
      });
      const smsMessageId = await this.deps.repository.insert({
        organizationId: input.organizationId,
        userId: input.userId,
        templateId: null,
        mobile: input.mobile,
        message: 'OTP voice call',
        provider: result.mock ? 'mock' : 'limo_sms',
        providerMessageId: result.messageIds[0] ?? null,
        purpose: input.purpose,
        status: 'sent',
        costAmount: result.totalAmount ?? this.deps.config.voiceUnitPriceIrr,
        attempts: 1,
        lastError: null,
      });
      return { smsMessageId, providerMessageId: result.messageIds[0] ?? null };
    } catch (error) {
      await this.deps.budget.release(reservation);
      await this.recordFailure(
        {
          organizationId: input.organizationId,
          userId: input.userId,
          mobile: input.mobile,
          code: input.code,
          purpose: input.purpose,
        },
        error,
      );
      throw this.toAppError(error);
    }
  }

  async sendAdHoc(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    message: string;
    purpose?: string;
    senderNumber?: string;
    ip?: string;
  }): Promise<{ smsMessageId: string; providerMessageId: string | null }> {
    await this.enforceLimits(input.mobile, input.ip, 'ad_hoc');
    const estimate = this.deps.config.unitPriceIrr * estimateSmsSegments(input.message);
    const reservation = await this.deps.budget.reserve(input.organizationId, estimate, 'sms');
    try {
      const result = await this.deps.client.sendSms({
        senderNumber: input.senderNumber ?? this.deps.config.senderNumber,
        message: input.message,
        mobiles: [input.mobile],
      });
      await this.deps.budget.reconcile(reservation, result.totalAmount);
      const smsMessageId = await this.deps.repository.insert({
        organizationId: input.organizationId,
        userId: input.userId,
        templateId: null,
        mobile: input.mobile,
        message: input.message,
        provider: result.mock ? 'mock' : 'limo_sms',
        providerMessageId: result.messageIds[0] ?? null,
        purpose: input.purpose ?? 'alert',
        status: 'sent',
        costAmount: result.totalAmount ?? estimate,
        attempts: 1,
        lastError: null,
      });
      return { smsMessageId, providerMessageId: result.messageIds[0] ?? null };
    } catch (error) {
      await this.deps.budget.release(reservation);
      await this.recordFailure(
        {
          organizationId: input.organizationId,
          userId: input.userId,
          mobile: input.mobile,
          code: '',
          purpose: input.purpose ?? 'alert',
        },
        error,
      );
      throw this.toAppError(error);
    }
  }

  /** Fixed-window limits; keys are hashed so mobile numbers never hit Redis. */
  private async enforceLimits(
    mobile: string,
    ip: string | undefined,
    kind: 'otp' | 'ad_hoc',
  ): Promise<void> {
    const hour = Math.floor(Date.now() / 3_600_000);
    const tenMinutes = Math.floor(Date.now() / 600_000);
    const mobileKey = phoneKey(mobile);
    if (kind === 'otp') {
      const hourly = await this.deps.store.incrBy(`sms:m:${mobileKey}:h:${hour}`, 1, 3600);
      if (hourly > OTP_SENDS_PER_HOUR) {
        throw new AppError('RATE_LIMITED', {
          message: 'تعداد ارسال کد به این شماره بیش از حد مجاز است.',
          retryAfter: 3600,
        });
      }
      const burst = await this.deps.store.incrBy(`sms:m:${mobileKey}:10:${tenMinutes}`, 1, 600);
      if (burst > OTP_RESENDS_PER_10_MIN) {
        throw new AppError('RATE_LIMITED', {
          message: 'فاصلهٔ ارسال کدها کوتاه است؛ کمی بعد تلاش کنید.',
          retryAfter: 600,
        });
      }
    } else {
      const hourly = await this.deps.store.incrBy(`sms:a:${mobileKey}:h:${hour}`, 1, 3600);
      if (hourly > 10) {
        throw new AppError('RATE_LIMITED', {
          message: 'تعداد پیامک‌های ارسالی به این شماره بیش از حد مجاز است.',
          retryAfter: 3600,
        });
      }
    }
    if (ip !== undefined) {
      const byIp = await this.deps.store.incrBy(`sms:ip:${ip}:h:${hour}`, 1, 3600);
      if (byIp > this.deps.config.ipHourlyLimit) {
        throw new AppError('RATE_LIMITED', {
          message: 'تعداد درخواست‌های پیامک از این نشانی بیش از حد مجاز است.',
          retryAfter: 3600,
        });
      }
    }
  }

  private async recordFailure(
    input: { organizationId: string; userId: string | null; mobile: string; code: string; purpose: string },
    error: unknown,
  ): Promise<void> {
    const code = error instanceof LimoError ? error.code : 'PROVIDER_UNAVAILABLE';
    try {
      await this.deps.repository.insert({
        organizationId: input.organizationId,
        userId: input.userId,
        templateId: null,
        mobile: input.mobile,
        message: 'failed send',
        provider: this.deps.config.mode === 'mock' ? 'mock' : 'limo_sms',
        providerMessageId: null,
        purpose: input.purpose,
        status: 'failed',
        costAmount: null,
        attempts: 1,
        lastError: code,
      });
    } catch (recordError) {
      this.deps.logger.error(
        {
          mobile: maskMobile(input.mobile),
          error: recordError instanceof Error ? recordError.message : 'record_failed',
        },
        'failed to record sms failure',
      );
    }
  }

  private toAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof LimoError) {
      switch (error.code) {
        case 'BUDGET_EXHAUSTED':
          return new AppError('RULE_VIOLATION', {
            message: error.messageFa,
            messageKey: 'error.sms_budget_exhausted',
          });
        case 'RATE_LIMITED':
          return new AppError('RATE_LIMITED', { message: error.messageFa, retryAfter: 60 });
        case 'INVALID_MOBILE':
        case 'INVALID_REQUEST':
          return new AppError('VALIDATION_ERROR', { message: error.messageFa });
        case 'BLOCKED_RECIPIENT':
          return new AppError('RULE_VIOLATION', { message: error.messageFa });
        case 'CONFIG':
          return new AppError('NOT_IMPLEMENTED', { message: error.messageFa });
        default:
          return new AppError('UPSTREAM_UNAVAILABLE', { message: error.messageFa });
      }
    }
    return new AppError('UPSTREAM_UNAVAILABLE', {
      message: 'ارسال پیامک با خطا مواجه شد.',
    });
  }
}

export { maskMobile, phoneKey, DEFAULT_SMS_UNIT_PRICE_IRR, type BudgetReservation };
