/**
 * RSA key-pair helpers for Digikala seller onboarding.
 *
 * Digikala asks each seller for a public key and keeps the private key on our
 * side. Keys never leave this module as plaintext except through
 * `ChannelAccountService.setCredentials` (encrypted at rest).
 */
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';

export type RsaKeyBits = 2048 | 4096;

export const RSA_KEY_BITS: RsaKeyBits = 4096;

export interface RsaKeypair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly publicKeyPkcs1: string;
  readonly publicKeyBase64: string;
  readonly fingerprint: string;
  readonly keyBits: number;
}

function assertRsa(key: KeyObject, code: string): void {
  if (key.asymmetricKeyType !== 'rsa') {
    const error = new Error(code);
    error.name = 'RsaKeyError';
    throw error;
  }
}

function rsaError(code: string): Error {
  const error = new Error(code);
  error.name = 'RsaKeyError';
  return error;
}

function asPublicKey(key: string | KeyObject): KeyObject {
  return typeof key === 'string' ? createPublicKey(key) : key;
}

/** Public key as SubjectPublicKeyInfo PEM (`BEGIN PUBLIC KEY`). */
export function publicKeySpkiPem(key: string | KeyObject): string {
  return asPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

/** Public key as PKCS#1 PEM (`BEGIN RSA PUBLIC KEY`). */
export function publicKeyPkcs1Pem(key: string | KeyObject): string {
  return asPublicKey(key).export({ type: 'pkcs1', format: 'pem' }).toString();
}

/** Raw base64 of the DER-encoded SPKI, without PEM headers or line breaks. */
export function publicKeyBase64Der(key: string | KeyObject): string {
  return asPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** SHA-256 of the DER-encoded SPKI, uppercase hex with `:` separators. */
export function publicKeyFingerprint(key: string | KeyObject): string {
  const der = asPublicKey(key).export({ type: 'spki', format: 'der' });
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/**
 * Accept a public key in SPKI PEM, PKCS#1 PEM or raw base64 DER (SPKI first,
 * PKCS#1 as a fallback) and return a normalized KeyObject.
 */
export function normalizePublicKey(input: string): KeyObject {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw rsaError('empty_public_key');
  if (trimmed.includes('-----BEGIN')) {
    const key = createPublicKey(trimmed);
    assertRsa(key, 'invalid_public_key_type');
    return key;
  }
  const compact = trimmed.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  let der: Buffer;
  try {
    der = Buffer.from(compact, 'base64');
  } catch {
    throw rsaError('invalid_public_key');
  }
  if (der.length === 0) throw rsaError('invalid_public_key');
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      const key = createPublicKey({ key: der, format: 'der', type });
      assertRsa(key, 'invalid_public_key_type');
      return key;
    } catch {
      // try the next DER container
    }
  }
  throw rsaError('invalid_public_key');
}

function keyBitsOf(key: KeyObject): number {
  return key.asymmetricKeyDetails?.modulusLength ?? RSA_KEY_BITS;
}

function isRsaKeyBits(value: number): value is RsaKeyBits {
  return value === 2048 || value === 4096;
}

export function generateRsaKeypair(bits: RsaKeyBits = RSA_KEY_BITS): RsaKeypair {
  if (!isRsaKeyBits(bits)) throw rsaError('invalid_key_bits');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    publicKeyPkcs1: publicKeyPkcs1Pem(publicKey),
    publicKeyBase64: publicKeyBase64Der(publicKey),
    fingerprint: publicKeyFingerprint(publicKey),
    keyBits: keyBitsOf(createPublicKey(publicKey)),
  };
}

/** Validate an imported private key and derive its SPKI public key. */
export function importRsaKeypair(privateKeyPem: string): RsaKeypair {
  const key = createPrivateKey(privateKeyPem);
  assertRsa(key, 'invalid_private_key_type');
  const publicKey = createPublicKey(key);
  const normalizedPrivate = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    privateKeyPem: normalizedPrivate,
    publicKeyPem: publicKeySpkiPem(publicKey),
    publicKeyPkcs1: publicKeyPkcs1Pem(publicKey),
    publicKeyBase64: publicKeyBase64Der(publicKey),
    fingerprint: publicKeyFingerprint(publicKey),
    keyBits: keyBitsOf(publicKey),
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Decrypt a Digikala RSA-OAEP-SHA256 field. `ciphertext` is base64 or
 * base64url. Throws when the ciphertext or key does not match; callers fall
 * back to the plain token.
 */
export function decryptRsaOaep(privateKeyPem: string, ciphertext: string): string {
  const key = createPrivateKey(privateKeyPem);
  assertRsa(key, 'invalid_private_key_type');
  let lastError: unknown = null;
  for (const encoding of ['base64', 'base64url'] as const) {
    try {
      const buffer = Buffer.from(ciphertext, encoding);
      if (buffer.length === 0) continue;
      return privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        buffer,
      ).toString('utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('rsa_decrypt_failed');
}
