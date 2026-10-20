import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { scryptSync, timingSafeEqual } from 'node:crypto';

/** Argon2id parameters from `SECURITY.md` (64 MB, 3 iterations, 1 lane). */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export interface PasswordPolicyContext {
  readonly username?: string;
  readonly mobile?: string;
  readonly fullName?: string;
  readonly orgName?: string;
}

export type PasswordPolicyViolation =
  | 'too_short'
  | 'too_long'
  | 'needs_three_character_classes'
  | 'contains_identity'
  | 'common_password'
  | 'low_entropy';

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
@Injectable()
export class PasswordService {
  hashPassword(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  async verifyPassword(passwordHash: string, plaintext: string): Promise<boolean> {
    // Bootstrap/admin seed hashes are dependency-free scrypt (`scrypt$N$r$p$salt$hash`)
    // because the DB package must run without native modules. Argon2id is used for
    // every password written by the API; both formats verify here.
    if (passwordHash.startsWith('scrypt$')) {
      return verifyScryptHash(passwordHash, plaintext);
    }
    try {
      return await verify(passwordHash, plaintext, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /** Returns stable violation codes; empty array = policy satisfied. */
  validatePolicy(password: string, context: PasswordPolicyContext = {}): PasswordPolicyViolation[] {
    const violations: PasswordPolicyViolation[] = [];
    if (password.length < 12) violations.push('too_short');
    if (password.length > 256) violations.push('too_long');

    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((pattern) => pattern.test(password));
    if (classes.length < 3) violations.push('needs_three_character_classes');

    const lowered = password.toLowerCase();
    const identityTokens = [context.username, context.mobile, context.fullName, context.orgName]
      .filter((value): value is string => typeof value === 'string' && value.length >= 3)
      .map((value) => value.toLowerCase());
    if (identityTokens.some((token) => lowered.includes(token))) {
      violations.push('contains_identity');
    }
    if (COMMON_PASSWORDS.has(lowered)) violations.push('common_password');

    // Cheap entropy estimate; zxcvbn is a worker-side enhancement (`SECURITY.md`).
    const uniqueChars = new Set(password).size;
    const entropyBits = password.length * Math.log2(Math.max(2, uniqueChars));
    if (entropyBits < 40) violations.push('low_entropy');

    return violations;
  }

  /** Reuse check against the last N stored hashes. */
  async isPasswordReused(plaintext: string, historyHashes: readonly string[]): Promise<boolean> {
    for (const historyHash of historyHashes) {
       
      if (await this.verifyPassword(historyHash, plaintext)) return true;
    }
    return false;
  }
}

/** scrypt fallback for bootstrap-seeded passwords (see packages/db/src/crypto.ts). */
function verifyScryptHash(stored: string, plaintext: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false;
  const actual = scryptSync(plaintext, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
