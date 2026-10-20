"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var CryptoService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRYPTO = exports.CryptoService = void 0;
exports.timingSafeEqualStrings = timingSafeEqualStrings;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const env_schema_1 = require("../../config/env.schema");
const contracts_1 = require("../contracts");
Object.defineProperty(exports, "CRYPTO", { enumerable: true, get: function () { return contracts_1.CRYPTO; } });
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = /^v(\d+)$/;
/** Constant-time string comparison (for tokens/secrets checks). */
function timingSafeEqualStrings(left, right) {
    const leftDigest = (0, node_crypto_1.createHash)('sha256').update(left, 'utf8').digest();
    const rightDigest = (0, node_crypto_1.createHash)('sha256').update(right, 'utf8').digest();
    return (0, node_crypto_1.timingSafeEqual)(leftDigest, rightDigest);
}
function decodeKey(secret) {
    try {
        const key = Buffer.from(secret, 'base64');
        return key.length === KEY_BYTES ? key : null;
    }
    catch {
        return null;
    }
}
/**
 * AES-256-GCM envelope encryption for channel credentials and secrets
 * (`SECURITY.md`, `APP_ENCRYPTION_KEY`). Envelope format is
 * `v<keyVersion>:<iv>:<tag>:<ciphertext>` (base64url parts), so keys can rotate by
 * bumping `APP_ENCRYPTION_KEY_VERSION` without re-reading the plaintext format.
 * GCM authenticates the payload; tampering fails decryption.
 */
let CryptoService = CryptoService_1 = class CryptoService {
    logger = new common_1.Logger(CryptoService_1.name);
    keyVersion;
    key;
    constructor(config) {
        this.keyVersion = config.encryptionKeyVersion;
        const decoded = decodeKey(config.encryptionKey);
        if (decoded !== null) {
            this.key = decoded;
            return;
        }
        if (config.appEnv === 'production') {
            throw new Error('APP_ENCRYPTION_KEY must be a base64 value of exactly 32 bytes');
        }
        // Dev/test only: keep boot working with the documented placeholder, but make
        // it loud and derive a stable key so local encrypted fixtures stay readable.
        this.logger.warn('APP_ENCRYPTION_KEY is not 32 base64 bytes; deriving a development-only key from it.');
        this.key = (0, node_crypto_1.createHash)('sha256').update(config.encryptionKey, 'utf8').digest();
    }
    /** Encrypts UTF-8 text into a versioned envelope string. */
    encrypt(plaintext) {
        const iv = (0, node_crypto_1.randomBytes)(IV_BYTES);
        const cipher = (0, node_crypto_1.createCipheriv)(ALGORITHM, this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [
            `v${this.keyVersion}`,
            iv.toString('base64url'),
            tag.toString('base64url'),
            ciphertext.toString('base64url'),
        ].join(':');
    }
    /** Decrypts a versioned envelope; throws when malformed, tampered or wrong version. */
    decrypt(envelope) {
        const parts = envelope.split(':');
        if (parts.length !== 4) {
            throw new Error('crypto: malformed envelope');
        }
        const [versionPart, ivPart, tagPart, ciphertextPart] = parts;
        const versionMatch = ENVELOPE_VERSION.exec(versionPart);
        if (versionMatch === null) {
            throw new Error('crypto: missing envelope version');
        }
        if (Number(versionMatch[1]) !== this.keyVersion) {
            throw new Error(`crypto: envelope key version ${versionMatch[1]} does not match active version ${this.keyVersion}`);
        }
        const iv = Buffer.from(ivPart, 'base64url');
        const tag = Buffer.from(tagPart, 'base64url');
        const ciphertext = Buffer.from(ciphertextPart, 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== 16) {
            throw new Error('crypto: malformed envelope');
        }
        const decipher = (0, node_crypto_1.createDecipheriv)(ALGORITHM, this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }
    /** SHA-256 hex fingerprint for equality checks/logs (never reversible). */
    fingerprint(plaintext) {
        return (0, node_crypto_1.createHash)('sha256').update(plaintext, 'utf8').digest('hex');
    }
};
exports.CryptoService = CryptoService;
exports.CryptoService = CryptoService = CryptoService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [Object])
], CryptoService);
