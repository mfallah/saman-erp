/**
 * OTP service — 6 digits, HMAC-SHA256 with `OTP_PEPPER`, 120 s TTL, max 5
 * attempts, single use, purpose binding (erp.otp_challenges).
 */
import { createHmac, randomInt } from 'node:crypto';

import { AppError, normalizeIranianMobile } from '@saman/shared';
import { OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS } from '../limo/limo.constants';
import type { Logger } from '../infrastructure/logger';
import type { OtpChallengeRow, OtpPurpose, OtpRepositoryPort } from './otp.repository';
import { OTP_PURPOSES } from './otp.repository';

/** Narrow port so OTP tests do not need the whole SMS stack. */
export interface OtpSmsSender {
  sendOtp(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    code: string;
    purpose: string;
    ip?: string;
  }): Promise<{ smsMessageId: string; providerMessageId: string | null; costAmount: number }>;
  sendVoiceOtp(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    code: string;
    purpose: string;
  }): Promise<{ smsMessageId: string; providerMessageId: string | null }>;
}

export interface OtpServiceOptions {
  readonly pepper: string;
  readonly appEnv: string;
  readonly ttlSeconds?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly codeGenerator?: () => string;
}

export type OtpVerifyReason =
  | 'verified'
  | 'invalid'
  | 'expired'
  | 'locked'
  | 'purpose_mismatch'
  | 'not_found';

export class OtpService {
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly generateCode: () => string;

  constructor(
    private readonly deps: {
      readonly repository: OtpRepositoryPort;
      readonly sms: OtpSmsSender;
      readonly logger: Logger;
      readonly options: OtpServiceOptions;
    },
  ) {
    if (deps.options.appEnv === 'production' && deps.options.pepper.trim().length < 16) {
      throw new AppError('INTERNAL', {
        message: 'OTP_PEPPER در محیط تولید تنظیم نشده است.',
        messageKey: 'error.otp_pepper_missing',
      });
    }
    this.ttlSeconds = deps.options.ttlSeconds ?? OTP_TTL_SECONDS;
    this.maxAttempts = deps.options.maxAttempts ?? OTP_MAX_ATTEMPTS;
    this.now = deps.options.now ?? (() => new Date());
    this.generateCode =
      deps.options.codeGenerator ?? (() => randomInt(0, 1_000_000).toString().padStart(6, '0'));
  }

  /** HMAC keeps a leaked DB row from being brute-forced offline cheaply. */
  hashCode(purpose: string, mobile: string, code: string): string {
    return createHmac('sha256', this.deps.options.pepper)
      .update(`${purpose}:${mobile}:${code}`, 'utf8')
      .digest('hex');
  }

  async issue(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    purpose: OtpPurpose;
    ip?: string;
    channel?: 'sms' | 'voice';
  }): Promise<{
    challengeId: string;
    expiresAt: Date;
    smsMessageId: string;
    channel: 'sms' | 'voice';
  }> {
    if (!(OTP_PURPOSES as readonly string[]).includes(input.purpose)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'کاربرد کد یکبارمصرف معتبر نیست.',
        details: [{ field: 'purpose', code: 'invalid_purpose' }],
      });
    }
    const mobile = normalizeIranianMobile(input.mobile);
    if (mobile === null) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'شمارهٔ موبایل معتبر نیست.',
        details: [{ field: 'mobile', code: 'invalid_mobile' }],
      });
    }
    const code = this.generateCode();
    if (!/^\d{6}$/.test(code)) throw new Error('otp_generator_invalid');
    const codeHash = this.hashCode(input.purpose, mobile, code);
    const challengeId = await this.deps.repository.create({
      organizationId: input.organizationId,
      userId: input.userId,
      mobile,
      purpose: input.purpose,
      codeHash,
      provider: 'limo_sms',
      ip: input.ip ?? null,
      ttlSeconds: this.ttlSeconds,
      maxAttempts: this.maxAttempts,
    });
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1000);

    try {
      if (input.channel === 'voice') {
        const sent = await this.deps.sms.sendVoiceOtp({
          organizationId: input.organizationId,
          userId: input.userId,
          mobile,
          code,
          purpose: input.purpose,
        });
        await this.deps.repository.attachProviderRequest(challengeId, sent.providerMessageId);
        this.deps.logger.info(
          { challengeId, purpose: input.purpose, channel: 'voice' },
          'otp issued',
        );
        return { challengeId, expiresAt, smsMessageId: sent.smsMessageId, channel: 'voice' };
      }
      const sent = await this.deps.sms.sendOtp({
        organizationId: input.organizationId,
        userId: input.userId,
        mobile,
        code,
        purpose: input.purpose,
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      });
      await this.deps.repository.attachProviderRequest(challengeId, sent.providerMessageId);
      this.deps.logger.info({ challengeId, purpose: input.purpose, channel: 'sms' }, 'otp issued');
      return { challengeId, expiresAt, smsMessageId: sent.smsMessageId, channel: 'sms' };
    } catch (error) {
      // A challenge whose SMS never left must not be redeemable.
      await this.deps.repository.invalidate(challengeId);
      throw error;
    }
  }

  async verify(input: {
    challengeId: string;
    code: string;
    purpose: OtpPurpose;
  }): Promise<{ ok: boolean; reason: OtpVerifyReason }> {
    if (!/^\d{6}$/.test(input.code)) return { ok: false, reason: 'invalid' };
    const challenge = await this.deps.repository.findById(input.challengeId);
    if (challenge === null) return { ok: false, reason: 'not_found' };
    if (challenge.purpose !== input.purpose) return { ok: false, reason: 'purpose_mismatch' };
    if (challenge.status === 'locked') return { ok: false, reason: 'locked' };
    if (challenge.status !== 'pending') return { ok: false, reason: 'invalid' };
    if (challenge.expiresAt === null || challenge.expiresAt.getTime() <= this.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (challenge.attemptCount >= challenge.maxAttempts) return { ok: false, reason: 'locked' };

    const codeHash = this.hashCode(input.purpose, challenge.mobile, input.code);
    const consumed = await this.deps.repository.consume({
      id: challenge.id,
      purpose: input.purpose,
      codeHash,
    });
    if (consumed) return { ok: true, reason: 'verified' };

    const failure = await this.deps.repository.registerFailure(challenge.id);
    this.deps.logger.warn(
      { challengeId: challenge.id, attempts: failure.attempts, purpose: input.purpose },
      'otp verification failed',
    );
    return { ok: false, reason: failure.locked ? 'locked' : 'invalid' };
  }

  /** For tests/ops: current challenge without the code hash. */
  async inspect(challengeId: string): Promise<Omit<OtpChallengeRow, 'codeHash'> | null> {
    const row = await this.deps.repository.findById(challengeId);
    if (row === null) return null;
    const { codeHash: _ignored, ...rest } = row;
    void _ignored;
    return rest;
  }
}
