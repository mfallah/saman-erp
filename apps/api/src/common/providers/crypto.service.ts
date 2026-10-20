import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { CRYPTO, type CryptoPort } from '../contracts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = /^v(\d+)$/;

/** Constant-time string comparison (for tokens/secrets checks). */
export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function decodeKey(secret: string): Buffer | null {
  try {
    const key = Buffer.from(secret, 'base64');
    return key.length === KEY_BYTES ? key : null;
  } catch {
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
@Injectable()
export class CryptoService implements CryptoPort {
  private readonly logger = new Logger(CryptoService.name);
  readonly keyVersion: number;
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
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
    this.logger.warn(
      'APP_ENCRYPTION_KEY is not 32 base64 bytes; deriving a development-only key from it.',
    );
    this.key = createHash('sha256').update(config.encryptionKey, 'utf8').digest();
  }

  /** Encrypts UTF-8 text into a versioned envelope string. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
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
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) {
      throw new Error('crypto: malformed envelope');
    }
    const [versionPart, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
    const versionMatch = ENVELOPE_VERSION.exec(versionPart);
    if (versionMatch === null) {
      throw new Error('crypto: missing envelope version');
    }
    if (Number(versionMatch[1]) !== this.keyVersion) {
      throw new Error(
        `crypto: envelope key version ${versionMatch[1]} does not match active version ${this.keyVersion}`,
      );
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new Error('crypto: malformed envelope');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** SHA-256 hex fingerprint for equality checks/logs (never reversible). */
  fingerprint(plaintext: string): string {
    return createHash('sha256').update(plaintext, 'utf8').digest('hex');
  }
}

export { CRYPTO };
