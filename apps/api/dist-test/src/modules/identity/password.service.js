"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PasswordService = void 0;
const common_1 = require("@nestjs/common");
const argon2_1 = require("@node-rs/argon2");
/** Argon2id parameters from `SECURITY.md` (64 MB, 3 iterations, 1 lane). */
const ARGON2_OPTIONS = {
    algorithm: 2 /* Algorithm.Argon2id */,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
};
const COMMON_PASSWORDS = new Set([
    'password',
    'password123',
    '123456789012',
    'qwertyuiop12',
    'admin1234567',
    'saman1234567',
    'iran12345678',
    'letmein12345',
    'welcome12345',
]);
/**
 * Argon2id password hashing/verification and policy checks (`ADR-0004`).
 * Verification is constant-time inside the native library; failures never
 * reveal whether the user exists (callers use one generic 401 message).
 */
let PasswordService = class PasswordService {
    hashPassword(plaintext) {
        return (0, argon2_1.hash)(plaintext, ARGON2_OPTIONS);
    }
    async verifyPassword(passwordHash, plaintext) {
        try {
            return await (0, argon2_1.verify)(passwordHash, plaintext, ARGON2_OPTIONS);
        }
        catch {
            return false;
        }
    }
    /** Returns stable violation codes; empty array = policy satisfied. */
    validatePolicy(password, context = {}) {
        const violations = [];
        if (password.length < 12)
            violations.push('too_short');
        if (password.length > 256)
            violations.push('too_long');
        const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((pattern) => pattern.test(password));
        if (classes.length < 3)
            violations.push('needs_three_character_classes');
        const lowered = password.toLowerCase();
        const identityTokens = [context.username, context.mobile, context.fullName, context.orgName]
            .filter((value) => typeof value === 'string' && value.length >= 3)
            .map((value) => value.toLowerCase());
        if (identityTokens.some((token) => lowered.includes(token))) {
            violations.push('contains_identity');
        }
        if (COMMON_PASSWORDS.has(lowered))
            violations.push('common_password');
        // Cheap entropy estimate; zxcvbn is a worker-side enhancement (`SECURITY.md`).
        const uniqueChars = new Set(password).size;
        const entropyBits = password.length * Math.log2(Math.max(2, uniqueChars));
        if (entropyBits < 40)
            violations.push('low_entropy');
        return violations;
    }
    /** Reuse check against the last N stored hashes. */
    async isPasswordReused(plaintext, historyHashes) {
        for (const historyHash of historyHashes) {
            if (await this.verifyPassword(historyHash, plaintext))
                return true;
        }
        return false;
    }
};
exports.PasswordService = PasswordService;
exports.PasswordService = PasswordService = __decorate([
    (0, common_1.Injectable)()
], PasswordService);
