"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenService = void 0;
exports.ttlToSeconds = ttlToSeconds;
exports.hashSecret = hashSecret;
exports.hashMatches = hashMatches;
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@saman/shared");
const ISSUER = 'saman-erp';
const AUDIENCE = 'saman-api';
/** `10m` / `7d` / `3600` style TTLs to seconds (contract uses durations in env). */
function ttlToSeconds(ttl) {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (match === null) {
        const seconds = Number(ttl);
        if (Number.isFinite(seconds) && seconds > 0)
            return Math.floor(seconds);
        throw new RangeError(`invalid_ttl:${ttl}`);
    }
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400;
    return value * multiplier;
}
function base64url(input) {
    return Buffer.from(input).toString('base64url');
}
function signSegment(data, secret) {
    return (0, node_crypto_1.createHmac)('sha256', secret).update(data, 'utf8').digest('base64url');
}
function encodeJwt(payload, secret) {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify(payload));
    const signature = signSegment(`${header}.${body}`, secret);
    return `${header}.${body}.${signature}`;
}
function decodeJwt(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
    }
    const [header, body, signature] = parts;
    const expected = signSegment(`${header}.${body}`, secret);
    const provided = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (provided.length !== expectedBuffer.length || !(0, node_crypto_1.timingSafeEqual)(provided, expectedBuffer)) {
        throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    }
    catch {
        throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_malformed' });
    }
    return parsed;
}
function verifyTimes(payload, nowSeconds) {
    if (payload['iss'] !== ISSUER || payload['aud'] !== AUDIENCE) {
        throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
    }
    const exp = payload['exp'];
    if (typeof exp !== 'number' || exp <= nowSeconds) {
        throw new shared_1.AppError('TOKEN_EXPIRED', { messageKey: 'error.token_expired' });
    }
}
/**
 * JWT (HS256) and opaque-token primitives for the two-token model (`ADR-0004`).
 * No external JWT dependency: the claims are small and fully owned here, and the
 * refresh/device/step-up tokens are CSPRNG values hashed with server peppers.
 */
class TokenService {
    options;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    }
    signAccessToken(input) {
        const iat = this.now();
        const exp = iat + this.options.accessTtlSeconds;
        const payload = {
            typ: 'access',
            sub: input.sub,
            sid: input.sid,
            org: input.org,
            pv: input.pv,
            mfa: input.mfa,
            amr: input.amr,
            scope: { branchIds: input.branchIds, warehouseIds: input.warehouseIds },
            jti: (0, node_crypto_1.randomBytes)(16).toString('base64url'),
            iat,
            exp,
            iss: ISSUER,
            aud: AUDIENCE,
        };
        return { token: encodeJwt(payload, this.options.secret), expiresIn: this.options.accessTtlSeconds };
    }
    verifyAccessToken(token) {
        const payload = decodeJwt(token, this.options.secret);
        verifyTimes(payload, this.now());
        if (payload['typ'] !== 'access') {
            throw new shared_1.AppError('UNAUTHENTICATED', { messageKey: 'identity.token_invalid' });
        }
        return payload;
    }
    signStepUpToken(input) {
        const ttl = this.options.stepUpTtlSeconds ?? 300;
        const iat = this.now();
        const payload = {
            typ: 'step_up',
            sub: input.sub,
            sid: input.sid,
            act: input.action,
            jti: (0, node_crypto_1.randomBytes)(16).toString('base64url'),
            iat,
            exp: iat + ttl,
            iss: ISSUER,
            aud: AUDIENCE,
        };
        return {
            token: encodeJwt(payload, this.options.secret),
            expiresIn: ttl,
        };
    }
    verifyStepUpToken(token) {
        const payload = decodeJwt(token, this.options.secret);
        verifyTimes(payload, this.now());
        if (payload['typ'] !== 'step_up') {
            throw new shared_1.AppError('STEP_UP_REQUIRED');
        }
        return payload;
    }
    /** 256-bit opaque refresh/device secret (cookie value). */
    generateOpaqueToken() {
        return (0, node_crypto_1.randomBytes)(32).toString('base64url');
    }
}
exports.TokenService = TokenService;
/** HMAC-SHA256 hex digest used for OTP codes, refresh tokens and device secrets. */
function hashSecret(value, pepper) {
    return (0, node_crypto_1.createHmac)('sha256', pepper).update(value, 'utf8').digest('hex');
}
/** Constant-time comparison of two hex digests. */
function hashMatches(expectedHex, actualHex) {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    if (expected.length !== actual.length || expected.length === 0)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(expected, actual);
}
