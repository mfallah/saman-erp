/**
 * Limo SMS client — contract-confirmed endpoints, `ApiKey` header.
 *
 * - `SMS_MODE=mock` never performs a network call and is refused in production.
 * - Provider `Success=false` maps to a stable Persian error code.
 * - Message bodies / full mobile numbers are never logged.
 */
import { createHash } from 'node:crypto';

import { normalizeIranianMobile } from '@saman/shared';

import { LIMO_BASE_URL, LIMO_PATHS, type SmsMode } from './limo.constants';
import { LimoError, mapProviderFailure } from './limo.errors';
import type {
  LimoPatternRequest,
  LimoPeerToPeerRequest,
  LimoProviderResponse,
  LimoResult,
  LimoSendCodeRequest,
  LimoSendSmsRequest,
  LimoVoiceOtpRequest,
} from './limo.types';
import type { Logger } from '../infrastructure/logger';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface LimoClientOptions {
  readonly mode: SmsMode;
  readonly apiKey?: string;
  readonly appEnv?: string;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly mockUnitPriceIrr?: number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const MOCK_UNIT_PRICE = 1_500;
const MAX_ATTEMPTS = 2;

export function estimateSmsSegments(message: string): number {
  // Pre-approved patterns are usually one segment; plain SMS uses 70 chars.
  return Math.max(1, Math.ceil(message.length / 70));
}

export class LimoSmsClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: LimoClientOptions) {
    if (options.mode === 'mock' && options.appEnv === 'production') {
      throw new LimoError('CONFIG', {
        providerMessage: 'SMS_MODE=mock is refused in production',
      });
    }
    if (options.mode === 'limo' && (options.apiKey === undefined || options.apiKey.length === 0)) {
      throw new LimoError('CONFIG');
    }
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  get mode(): SmsMode {
    return this.options.mode;
  }

  async sendSms(input: {
    senderNumber: string;
    message: string;
    mobiles: readonly string[];
    sendToBlocksNumber?: boolean;
    sendTimeSpan?: number;
  }): Promise<LimoResult> {
    if (input.message.trim().length === 0) throw new LimoError('INVALID_REQUEST');
    if (input.mobiles.length === 0) throw new LimoError('INVALID_REQUEST');
    const request: LimoSendSmsRequest = {
      SenderNumber: input.senderNumber,
      Message: input.message,
      MobileNumber: input.mobiles.map((mobile) => this.normalizeMobile(mobile)),
      ...(input.sendToBlocksNumber === undefined
        ? {}
        : { SendToBlocksNumber: input.sendToBlocksNumber }),
      ...(input.sendTimeSpan === undefined ? {} : { SendTimeSpan: input.sendTimeSpan }),
    };
    return this.post('limo.send_sms', LIMO_PATHS.sendSms, request, {
      recipients: request.MobileNumber.length,
      segments: estimateSmsSegments(input.message),
    });
  }

  async sendPeerToPeer(input: {
    senderNumber: string;
    messages: readonly string[];
    mobiles: readonly string[];
    sendToBlocksNumber?: boolean;
    sendTimeSpan?: number;
  }): Promise<LimoResult> {
    if (input.messages.length === 0 || input.messages.length !== input.mobiles.length) {
      throw new LimoError('INVALID_REQUEST');
    }
    const request: LimoPeerToPeerRequest = {
      SenderNumber: input.senderNumber,
      Message: input.messages,
      MobileNumber: input.mobiles.map((mobile) => this.normalizeMobile(mobile)),
      ...(input.sendToBlocksNumber === undefined
        ? {}
        : { SendToBlocksNumber: input.sendToBlocksNumber }),
      ...(input.sendTimeSpan === undefined ? {} : { SendTimeSpan: input.sendTimeSpan }),
    };
    return this.post('limo.send_peer_to_peer', LIMO_PATHS.sendPeerToPeer, request, {
      recipients: request.MobileNumber.length,
      segments: input.messages.reduce((sum, message) => sum + estimateSmsSegments(message), 0),
    });
  }

  async sendPattern(input: {
    otpId: number;
    replaceTokens: readonly string[];
    mobile: string;
    send?: boolean;
  }): Promise<LimoResult> {
    if (!Number.isInteger(input.otpId) || input.otpId <= 0) throw new LimoError('INVALID_REQUEST');
    const request: LimoPatternRequest = {
      OtpId: input.otpId,
      ReplaceToken: [...input.replaceTokens],
      MobileNumber: this.normalizeMobile(input.mobile),
      Send: input.send ?? true,
    };
    return this.post('limo.send_pattern', LIMO_PATHS.sendPattern, request, {
      recipients: 1,
      segments: 1,
    });
  }

  async sendCode(input: { mobile: string; footer: string }): Promise<LimoResult> {
    const request: LimoSendCodeRequest = {
      Mobile: this.normalizeMobile(input.mobile),
      Footer: input.footer,
    };
    return this.post('limo.send_code', LIMO_PATHS.sendCode, request, {
      recipients: 1,
      segments: 1,
    });
  }

  async sendVoiceOtp(input: {
    phoneNumber: string;
    generateCode?: string;
  }): Promise<LimoResult> {
    const request: LimoVoiceOtpRequest = {
      PhoneNumber: this.normalizeMobile(input.phoneNumber),
      ...(input.generateCode === undefined ? {} : { GenerateCode: input.generateCode }),
    };
    return this.post('limo.send_voice_otp', LIMO_PATHS.sendVoiceOtp, request, {
      recipients: 1,
      segments: 1,
    });
  }

  private normalizeMobile(input: string): string {
    const normalized = normalizeIranianMobile(input);
    if (normalized === null) throw new LimoError('INVALID_MOBILE');
    return normalized;
  }

  private async post(
    operation: string,
    path: string,
    body: unknown,
    estimate: { recipients: number; segments: number },
  ): Promise<LimoResult> {
    if (this.options.mode === 'mock') {
      const digest = createHash('sha256')
        .update(`${operation}:${JSON.stringify(body)}`)
        .digest('hex')
        .slice(0, 12);
      const totalAmount =
        estimate.recipients *
        estimate.segments *
        (this.options.mockUnitPriceIrr ?? MOCK_UNIT_PRICE);
      this.options.logger.info(
        { operation, recipients: estimate.recipients, mock: true, totalAmount },
        'mock sms accepted',
      );
      return {
        success: true,
        messageIds: Array.from({ length: estimate.recipients }, (_, index) => `mock-${digest}-${index}`),
        totalAmount,
        generatedCode: null,
        providerMessage: 'mock',
        mock: true,
      };
    }

    let lastError: LimoError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${LIMO_BASE_URL}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apiKey: this.options.apiKey ?? '',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await response.text();
        const payload = this.parse(text);
        if (response.status === 429) {
          throw new LimoError('RATE_LIMITED', { retryable: true, providerMessage: payload.Message ?? null });
        }
        if (response.status >= 500) {
          throw new LimoError('PROVIDER_UNAVAILABLE', {
            retryable: true,
            providerMessage: payload.Message ?? null,
          });
        }
        if (!response.ok) {
          throw new LimoError('PROVIDER_REJECTED', { providerMessage: payload.Message ?? null });
        }
        if (payload.Success !== true) throw mapProviderFailure(payload.Message);

        const messageIds = Array.isArray(payload.MessageId)
          ? payload.MessageId.filter((id): id is string => typeof id === 'string')
          : [];
        return {
          success: true,
          messageIds,
          totalAmount: typeof payload.TotalAmount === 'number' ? payload.TotalAmount : null,
          generatedCode: typeof payload.GenerateCode === 'string' ? payload.GenerateCode : null,
          providerMessage: typeof payload.Message === 'string' ? payload.Message.slice(0, 300) : '',
          mock: false,
        };
      } catch (error) {
        const mapped =
          error instanceof LimoError
            ? error
            : new LimoError('PROVIDER_UNAVAILABLE', {
                retryable: true,
                cause: error,
              });
        lastError = mapped;
        if (!mapped.retryable || attempt >= MAX_ATTEMPTS) throw mapped;
        await this.sleepImpl(Math.floor(this.random() * 500 * attempt) + 100);
      }
    }
    throw lastError ?? new LimoError('PROVIDER_UNAVAILABLE', { retryable: true });
  }

  private parse(text: string): LimoProviderResponse {
    if (text.trim().length === 0) return { Success: false, Message: 'empty response' };
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as LimoProviderResponse)
        : { Success: false, Message: 'invalid response' };
    } catch {
      return { Success: false, Message: 'invalid response' };
    }
  }
}
