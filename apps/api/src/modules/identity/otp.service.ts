import { randomInt } from 'node:crypto';

import { hashSecret, hashMatches } from './token.service';

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 120;
export const OTP_MAX_ATTEMPTS = 5;

/** CSPRNG 6-digit OTP (leading zeros preserved). */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0');
}

export interface OtpHashInput {
  readonly pepper: string;
  readonly mobile: string;
  readonly purpose: string;
  readonly code: string;
}

/** `hmac-sha256(OTP_PEPPER, "${mobile}:${purpose}:${code}")` (`SECURITY.md`). */
export function hashOtpCode(input: OtpHashInput): string {
  return hashSecret(`${input.mobile}:${input.purpose}:${input.code}`, input.pepper);
}

/** Constant-time OTP hash comparison. */
export function otpCodeMatches(storedHash: string, candidate: OtpHashInput): boolean {
  return hashMatches(storedHash, hashOtpCode(candidate));
}

/** Masks a mobile for public responses: `0912***6789`. */
export function maskMobile(mobile: string): string {
  if (mobile.length < 7) return '***';
  return `${mobile.slice(0, 4)}***${mobile.slice(-4)}`;
}

export class OtpService {
  constructor(
    private readonly pepper: string,
    private readonly options: { readonly ttlSeconds?: number; readonly maxAttempts?: number } = {},
  ) {}

  get ttlSeconds(): number {
    return this.options.ttlSeconds ?? OTP_TTL_SECONDS;
  }

  get maxAttempts(): number {
    return this.options.maxAttempts ?? OTP_MAX_ATTEMPTS;
  }

  generate(): string {
    return generateOtpCode();
  }

  hash(mobile: string, purpose: string, code: string): string {
    return hashOtpCode({ pepper: this.pepper, mobile, purpose, code });
  }

  matches(storedHash: string, mobile: string, purpose: string, code: string): boolean {
    return otpCodeMatches(storedHash, { pepper: this.pepper, mobile, purpose, code });
  }
}
