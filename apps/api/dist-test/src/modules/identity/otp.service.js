"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpService = exports.OTP_MAX_ATTEMPTS = exports.OTP_TTL_SECONDS = exports.OTP_CODE_LENGTH = void 0;
exports.generateOtpCode = generateOtpCode;
exports.hashOtpCode = hashOtpCode;
exports.otpCodeMatches = otpCodeMatches;
exports.maskMobile = maskMobile;
const node_crypto_1 = require("node:crypto");
const token_service_1 = require("./token.service");
exports.OTP_CODE_LENGTH = 6;
exports.OTP_TTL_SECONDS = 120;
exports.OTP_MAX_ATTEMPTS = 5;
/** CSPRNG 6-digit OTP (leading zeros preserved). */
function generateOtpCode() {
    return String((0, node_crypto_1.randomInt)(0, 10 ** exports.OTP_CODE_LENGTH)).padStart(exports.OTP_CODE_LENGTH, '0');
}
/** `hmac-sha256(OTP_PEPPER, "${mobile}:${purpose}:${code}")` (`SECURITY.md`). */
function hashOtpCode(input) {
    return (0, token_service_1.hashSecret)(`${input.mobile}:${input.purpose}:${input.code}`, input.pepper);
}
/** Constant-time OTP hash comparison. */
function otpCodeMatches(storedHash, candidate) {
    return (0, token_service_1.hashMatches)(storedHash, hashOtpCode(candidate));
}
/** Masks a mobile for public responses: `0912***6789`. */
function maskMobile(mobile) {
    if (mobile.length < 7)
        return '***';
    return `${mobile.slice(0, 4)}***${mobile.slice(-4)}`;
}
class OtpService {
    pepper;
    options;
    constructor(pepper, options = {}) {
        this.pepper = pepper;
        this.options = options;
    }
    get ttlSeconds() {
        return this.options.ttlSeconds ?? exports.OTP_TTL_SECONDS;
    }
    get maxAttempts() {
        return this.options.maxAttempts ?? exports.OTP_MAX_ATTEMPTS;
    }
    generate() {
        return generateOtpCode();
    }
    hash(mobile, purpose, code) {
        return hashOtpCode({ pepper: this.pepper, mobile, purpose, code });
    }
    matches(storedHash, mobile, purpose, code) {
        return otpCodeMatches(storedHash, { pepper: this.pepper, mobile, purpose, code });
    }
}
exports.OtpService = OtpService;
