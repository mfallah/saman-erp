import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AppError } from '@saman/shared';

const ISSUER = 'saman-erp';
const AUDIENCE = 'saman-api';

export interface AccessTokenClaims {
  readonly typ: 'access';
  readonly sub: string;
  readonly sid: string;
  readonly org: string;
  readonly pv: number;
  readonly mfa: boolean;
  readonly amr: readonly string[];
  readonly scope: { readonly branchIds: readonly string[]; readonly warehouseIds: readonly string[] };
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

export interface StepUpTokenClaims {
  readonly typ: 'step_up';
  readonly sub: string;
  readonly sid: string;
  readonly act: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

export interface TokenServiceOptions {
  readonly secret: string;
  readonly accessTtlSeconds: number;
  readonly stepUpTtlSeconds?: number;
  readonly now?: () => number;
}

/** `10m` / `7d` / `3600` style TTLs to seconds (contract uses durations in env). */
export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (match === null) {
    const seconds = Number(ttl);
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
    throw new RangeError(`invalid_ttl:${ttl}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400;
  return value * multiplier;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signSegment(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

function encodeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = signSegment(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

function decodeJwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
  }
  const [header, body, signature] = parts as [string, string, string];
  const expected = signSegment(`${header}.${body}`, secret);
  const provided = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
  }
  return parsed as Record<string, unknown>;
}

function verifyTimes(payload: Record<string, unknown>, nowSeconds: number): void {
  if (payload['iss'] !== ISSUER || payload['aud'] !== AUDIENCE) {
    throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
  }
  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp <= nowSeconds) {
    throw new AppError('TOKEN_EXPIRED', { messageKey: 'error.token_expired' });
  }
}

/**
 * JWT (HS256) and opaque-token primitives for the two-token model (`ADR-0004`).
 * No external JWT dependency: the claims are small and fully owned here, and the
 * refresh/device/step-up tokens are CSPRNG values hashed with server peppers.
 */
export class TokenService {
  private readonly now: () => number;

  constructor(private readonly options: TokenServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  signAccessToken(input: {
    sub: string;
    sid: string;
    org: string;
    pv: number;
    mfa: boolean;
    amr: readonly string[];
    branchIds: readonly string[];
    warehouseIds: readonly string[];
  }): { token: string; expiresIn: number } {
    const iat = this.now();
    const exp = iat + this.options.accessTtlSeconds;
    const payload: AccessTokenClaims = {
      typ: 'access',
      sub: input.sub,
      sid: input.sid,
      org: input.org,
      pv: input.pv,
      mfa: input.mfa,
      amr: input.amr,
      scope: { branchIds: input.branchIds, warehouseIds: input.warehouseIds },
      jti: randomBytes(16).toString('base64url'),
      iat,
      exp,
      iss: ISSUER,
      aud: AUDIENCE,
    };
    return { token: encodeJwt(payload as unknown as Record<string, unknown>, this.options.secret), expiresIn: this.options.accessTtlSeconds };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const payload = decodeJwt(token, this.options.secret);
    verifyTimes(payload, this.now());
    if (payload['typ'] !== 'access') {
      throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
    }
    return payload as unknown as AccessTokenClaims;
  }

  signStepUpToken(input: { sub: string; sid: string; action: string }): { token: string; expiresIn: number } {
    const ttl = this.options.stepUpTtlSeconds ?? 300;
    const iat = this.now();
    const payload: StepUpTokenClaims = {
      typ: 'step_up',
      sub: input.sub,
      sid: input.sid,
      act: input.action,
      jti: randomBytes(16).toString('base64url'),
      iat,
      exp: iat + ttl,
      iss: ISSUER,
      aud: AUDIENCE,
    };
    return {
      token: encodeJwt(payload as unknown as Record<string, unknown>, this.options.secret),
      expiresIn: ttl,
    };
  }

  verifyStepUpToken(token: string): StepUpTokenClaims {
    const payload = decodeJwt(token, this.options.secret);
    verifyTimes(payload, this.now());
    if (payload['typ'] !== 'step_up') {
      throw new AppError('STEP_UP_REQUIRED');
    }
    return payload as unknown as StepUpTokenClaims;
  }

  /** 256-bit opaque refresh/device secret (cookie value). */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }
}

/** HMAC-SHA256 hex digest used for OTP codes, refresh tokens and device secrets. */
export function hashSecret(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashMatches(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}
