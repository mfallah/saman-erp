import { describe, it } from 'node:test';

import { expect } from './support/expect';
import { hashMatches, hashSecret, TokenService, ttlToSeconds } from '../src/modules/identity/token.service';
import { OtpService, maskMobile } from '../src/modules/identity/otp.service';
import { PasswordService } from '../src/modules/identity/password.service';

const SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
const PEPPER = 'test-pepper-that-is-long-enough-for-hmac';

function tokens(now = 1_700_000_000): TokenService {
  return new TokenService({ secret: SECRET, accessTtlSeconds: 600, now: () => now });
}

describe('token service', () => {
  it('signs and verifies access tokens with scope and pv', () => {
    const service = tokens();
    const issued = service.signAccessToken({
      sub: '0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
      sid: '1f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
      org: '2f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
      pv: 7,
      mfa: true,
      amr: ['password'],
      branchIds: ['1'],
      warehouseIds: [],
    });
    const claims = service.verifyAccessToken(issued.token);
    expect(claims.sub).toBe('0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11');
    expect(claims.pv).toBe(7);
    expect(claims.mfa).toBe(true);
    expect(issued.expiresIn).toBe(600);
  });

  it('rejects tampered tokens and expired tokens', () => {
    const service = tokens();
    const issued = service.signAccessToken({
      sub: 'a',
      sid: 'b',
      org: 'c',
      pv: 1,
      mfa: false,
      amr: ['otp'],
      branchIds: [],
      warehouseIds: [],
    });
    expect(() => service.verifyAccessToken(`${issued.token}x`)).toThrow();
    const expired = new TokenService({ secret: SECRET, accessTtlSeconds: 1, now: () => 1000 });
    const token = expired.signAccessToken({
      sub: 'a',
      sid: 'b',
      org: 'c',
      pv: 1,
      mfa: false,
      amr: ['otp'],
      branchIds: [],
      warehouseIds: [],
    }).token;
    const later = new TokenService({ secret: SECRET, accessTtlSeconds: 1, now: () => 1002 });
    expect(() => later.verifyAccessToken(token)).toThrow();
  });

  it('signs step-up tokens bound to action and session', () => {
    const service = tokens();
    const issued = service.signStepUpToken({ sub: 'user', sid: 'session', action: 'accounting.journal.post' });
    const claims = service.verifyStepUpToken(issued.token);
    expect(claims.act).toBe('accounting.journal.post');
    expect(claims.sid).toBe('session');
    expect(issued.expiresIn).toBe(300);
    expect(() => service.verifyAccessToken(issued.token)).toThrow();
  });

  it('hashes secrets with constant-time comparison and parses TTLs', () => {
    expect(hashSecret('value', PEPPER)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMatches(hashSecret('value', PEPPER), hashSecret('value', PEPPER))).toBe(true);
    expect(hashMatches(hashSecret('value', PEPPER), hashSecret('other', PEPPER))).toBe(false);
    expect(ttlToSeconds('10m')).toBe(600);
    expect(ttlToSeconds('7d')).toBe(604_800);
    expect(() => ttlToSeconds('nope')).toThrow();
  });
});

describe('otp service', () => {
  const service = new OtpService(PEPPER);

  it('generates six-digit codes and verifies the peppered hash', () => {
    const code = service.generate();
    expect(code).toMatch(/^\d{6}$/);
    const hash = service.hash('09123456789', 'login', code);
    expect(service.matches(hash, '09123456789', 'login', code)).toBe(true);
    expect(service.matches(hash, '09123456789', 'login', '000000')).toBe(false);
    expect(service.matches(hash, '09120000000', 'login', code)).toBe(false);
  });

  it('masks mobiles for public responses', () => {
    expect(maskMobile('09123456789')).toBe('0912***6789');
  });
});

describe('password service', () => {
  it('hashes with Argon2id and verifies', async () => {
    const service = new PasswordService();
    const hash = await service.hashPassword('CorrectHorseBattery9');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await service.verifyPassword(hash, 'CorrectHorseBattery9')).toBe(true);
    expect(await service.verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('enforces policy and detects reuse', async () => {
    const service = new PasswordService();
    expect(service.validatePolicy('short')).toContain('too_short');
    expect(service.validatePolicy('password123')).toContain('common_password');
    expect(service.validatePolicy('CorrectHorseBattery9')).toEqual([]);
    const hash = await service.hashPassword('CorrectHorseBattery9');
    expect(await service.isPasswordReused('CorrectHorseBattery9', [hash])).toBe(true);
    expect(await service.isPasswordReused('AnotherStrongPass42', [hash])).toBe(false);
  });
});
