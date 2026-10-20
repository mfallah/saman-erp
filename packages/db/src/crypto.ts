import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Bootstrap-only password hashing (scrypt, dependency-free offline build).
 * Runtime identity module should verify against the stored format; when argon2id
 * lands (P1 hardening), `password_hash` starts with `$argon2id$` and this format is
 * only used for bootstrap/reset. Documented in MIGRATION-STATUS.md.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** SHA-256 hex helper used for token/device-secret hashes. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
