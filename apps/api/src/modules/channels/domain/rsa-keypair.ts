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

export const RSA_KEY_BITS = 4096;

export interface RsaKeypair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
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

/** SHA-256 of the DER-encoded SPKI, uppercase hex with `:` separators. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
  return (hex.match(/.{2}/g) ?? []).join(':');
}

function keyBitsOf(key: KeyObject): number {
  return key.asymmetricKeyDetails?.modulusLength ?? RSA_KEY_BITS;
}

export function generateRsaKeypair(): RsaKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_KEY_BITS,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    fingerprint: publicKeyFingerprint(publicKey),
    keyBits: RSA_KEY_BITS,
  };
}

/** Validate an imported private key and derive its SPKI public key. */
export function importRsaKeypair(privateKeyPem: string): RsaKeypair {
  const key = createPrivateKey(privateKeyPem);
  assertRsa(key, 'invalid_private_key_type');
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const normalizedPrivate = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    privateKeyPem: normalizedPrivate,
    publicKeyPem,
    fingerprint: publicKeyFingerprint(publicKeyPem),
    keyBits: keyBitsOf(key),
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
