"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const expect_1 = require("./support/expect");
const token_service_1 = require("../src/modules/identity/token.service");
const otp_service_1 = require("../src/modules/identity/otp.service");
const password_service_1 = require("../src/modules/identity/password.service");
const SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
const PEPPER = 'test-pepper-that-is-long-enough-for-hmac';
function tokens(now = 1_700_000_000) {
    return new token_service_1.TokenService({ secret: SECRET, accessTtlSeconds: 600, now: () => now });
}
(0, node_test_1.describe)('token service', () => {
    (0, node_test_1.it)('signs and verifies access tokens with scope and pv', () => {
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
        (0, expect_1.expect)(claims.sub).toBe('0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11');
        (0, expect_1.expect)(claims.pv).toBe(7);
        (0, expect_1.expect)(claims.mfa).toBe(true);
        (0, expect_1.expect)(issued.expiresIn).toBe(600);
    });
    (0, node_test_1.it)('rejects tampered tokens and expired tokens', () => {
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
        (0, expect_1.expect)(() => service.verifyAccessToken(`${issued.token}x`)).toThrow();
        const expired = new token_service_1.TokenService({ secret: SECRET, accessTtlSeconds: 1, now: () => 1000 });
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
        const later = new token_service_1.TokenService({ secret: SECRET, accessTtlSeconds: 1, now: () => 1002 });
        (0, expect_1.expect)(() => later.verifyAccessToken(token)).toThrow();
    });
    (0, node_test_1.it)('signs step-up tokens bound to action and session', () => {
        const service = tokens();
        const issued = service.signStepUpToken({ sub: 'user', sid: 'session', action: 'accounting.journal.post' });
        const claims = service.verifyStepUpToken(issued.token);
        (0, expect_1.expect)(claims.act).toBe('accounting.journal.post');
        (0, expect_1.expect)(claims.sid).toBe('session');
        (0, expect_1.expect)(issued.expiresIn).toBe(300);
        (0, expect_1.expect)(() => service.verifyAccessToken(issued.token)).toThrow();
    });
    (0, node_test_1.it)('hashes secrets with constant-time comparison and parses TTLs', () => {
        (0, expect_1.expect)((0, token_service_1.hashSecret)('value', PEPPER)).toMatch(/^[0-9a-f]{64}$/);
        (0, expect_1.expect)((0, token_service_1.hashMatches)((0, token_service_1.hashSecret)('value', PEPPER), (0, token_service_1.hashSecret)('value', PEPPER))).toBe(true);
        (0, expect_1.expect)((0, token_service_1.hashMatches)((0, token_service_1.hashSecret)('value', PEPPER), (0, token_service_1.hashSecret)('other', PEPPER))).toBe(false);
        (0, expect_1.expect)((0, token_service_1.ttlToSeconds)('10m')).toBe(600);
        (0, expect_1.expect)((0, token_service_1.ttlToSeconds)('7d')).toBe(604_800);
        (0, expect_1.expect)(() => (0, token_service_1.ttlToSeconds)('nope')).toThrow();
    });
});
(0, node_test_1.describe)('otp service', () => {
    const service = new otp_service_1.OtpService(PEPPER);
    (0, node_test_1.it)('generates six-digit codes and verifies the peppered hash', () => {
        const code = service.generate();
        (0, expect_1.expect)(code).toMatch(/^\d{6}$/);
        const hash = service.hash('09123456789', 'login', code);
        (0, expect_1.expect)(service.matches(hash, '09123456789', 'login', code)).toBe(true);
        (0, expect_1.expect)(service.matches(hash, '09123456789', 'login', '000000')).toBe(false);
        (0, expect_1.expect)(service.matches(hash, '09120000000', 'login', code)).toBe(false);
    });
    (0, node_test_1.it)('masks mobiles for public responses', () => {
        (0, expect_1.expect)((0, otp_service_1.maskMobile)('09123456789')).toBe('0912***6789');
    });
});
(0, node_test_1.describe)('password service', () => {
    (0, node_test_1.it)('hashes with Argon2id and verifies', async () => {
        const service = new password_service_1.PasswordService();
        const hash = await service.hashPassword('CorrectHorseBattery9');
        (0, expect_1.expect)(hash.startsWith('$argon2id$')).toBe(true);
        (0, expect_1.expect)(await service.verifyPassword(hash, 'CorrectHorseBattery9')).toBe(true);
        (0, expect_1.expect)(await service.verifyPassword(hash, 'wrong-password')).toBe(false);
    });
    (0, node_test_1.it)('enforces policy and detects reuse', async () => {
        const service = new password_service_1.PasswordService();
        (0, expect_1.expect)(service.validatePolicy('short')).toContain('too_short');
        (0, expect_1.expect)(service.validatePolicy('password123')).toContain('common_password');
        (0, expect_1.expect)(service.validatePolicy('CorrectHorseBattery9')).toEqual([]);
        const hash = await service.hashPassword('CorrectHorseBattery9');
        (0, expect_1.expect)(await service.isPasswordReused('CorrectHorseBattery9', [hash])).toBe(true);
        (0, expect_1.expect)(await service.isPasswordReused('AnotherStrongPass42', [hash])).toBe(false);
    });
});
