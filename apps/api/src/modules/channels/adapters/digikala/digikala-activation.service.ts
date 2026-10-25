/**
 * Digikala token activation.
 *
 * Digikala's seller panel (Service Hub) gives the seller exactly two factors:
 * a "client code" and a short-lived "validation code". The validation code is
 * the seller's public key encrypted authorization code: base64-decode it,
 * decrypt it with the matching RSA private key, and POST the plaintext to
 * `/open-api/v1/auth/token` as `authorization_code` to receive tokens.
 *
 * The live endpoint validates `authorization_code`; older/alternate payload
 * shapes are kept as fallbacks because Digikala's public documentation is thin.
 */
import { constants, createHash, privateDecrypt } from 'node:crypto';

export type DigikalaDecryption = 'pkcs1' | 'oaep-sha1' | 'oaep-sha256';

export interface DigikalaActivationInput {
  readonly validationCode: string;
  readonly clientCode?: string;
  readonly clientSecret?: string;
  readonly privateKeyPem: string;
  /** SHA-256 fingerprint of the stored public key, added to decryption errors. */
  readonly publicKeyFingerprint?: string;
  readonly baseUrl?: string;
}

export interface DigikalaActivationResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number | null;
  readonly decryption: DigikalaDecryption;
  readonly endpoint: string;
  readonly payloadVariant: string;
  readonly raw: Record<string, unknown>;
}

/** Thrown when the validation code cannot be decrypted with the stored key. */
export class RsaDecryptionError extends Error {
  readonly attempts: readonly string[];
  readonly fingerprint: string | null;

  constructor(fingerprint: string | null, attempts: readonly string[]) {
    const keyHint =
      fingerprint === null
        ? 'اثر انگشت کلید عمومی ذخیره‌شده در دسترس نیست.'
        : `اثر انگشت SHA-256 کلید عمومی ذخیره‌شده: ${fingerprint}`;
    super(
      'رمزگشایی کد اعتبارسنجی با کلید خصوصی ذخیره‌شده ناموفق بود. ' +
        `${keyHint}. دیجی‌کالا باید دقیقاً همین کلید عمومی را داشته باشد؛ ` +
        'اگر کلید عمومی ثبت‌شده در پنل با این اثر انگشت یکسان نیست، «تولید مجدد جفت‌کلید» را بزنید، ' +
        'کلید عمومی جدید را در پنل ثبت کنید و سپس یک کد اعتبارسنجی تازه بگیرید.',
    );
    this.name = 'RsaDecryptionError';
    this.attempts = attempts;
    this.fingerprint = fingerprint;
  }
}

interface CiphertextCandidate {
  readonly label: string;
  readonly bytes: Buffer;
}

/**
 * Digikala may return standard base64, base64url, or base64 wrapped over
 * several lines. Normalize all three before decoding.
 */
function ciphertextCandidates(validationCode: string): CiphertextCandidate[] {
  const compact = validationCode.replace(/\s+/g, '');
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');

  const seen = new Set<string>();
  const candidates: CiphertextCandidate[] = [];
  const add = (value: string, encoding: 'base64' | 'base64url', label: string): void => {
    if (value.length === 0) return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value, encoding);
    } catch {
      return;
    }
    if (bytes.length === 0) return;
    const key = bytes.toString('hex');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ label, bytes });
  };

  add(padded, 'base64', 'base64');
  add(compact, 'base64url', 'base64url');
  return candidates;
}

interface DecryptionMethod {
  readonly name: DigikalaDecryption;
  readonly padding: number;
  readonly oaepHash?: 'sha1' | 'sha256';
}

const DECRYPTION_METHODS: readonly DecryptionMethod[] = [
  { name: 'pkcs1', padding: constants.RSA_PKCS1_PADDING },
  { name: 'oaep-sha1', padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
  { name: 'oaep-sha256', padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
];


/**
 * Node 20.12+/22 refuse RSA_PKCS1_PADDING for privateDecrypt. Digikala's older
 * panels encrypt with PKCS#1 v1.5, so decrypt with RSA_NO_PADDING and strip the
 * 0x00 0x02 <padding> 0x00 header ourselves.
 */
function tryManualPkcs1(ciphertext: Buffer, keyPem: string): string | null {
  try {
    const raw = privateDecrypt({ key: keyPem, padding: constants.RSA_NO_PADDING }, ciphertext);
    if (raw.length < 12 || raw[0] !== 0x00 || raw[1] !== 0x02) return null;
    let index = 2;
    while (index < raw.length && raw[index] !== 0x00) index += 1;
    if (index < 10 || index >= raw.length - 1) return null;
    return raw.subarray(index + 1).toString('utf8');
  } catch {
    return null;
  }
}


/** MGF1 mask generation (OAEP) with a configurable hash. */
function mgf1(seed: Buffer, length: number, hash: 'sha1' | 'sha256'): Buffer {
  const hLen = hash === 'sha256' ? 32 : 20;
  const out = Buffer.alloc(length);
  let counter = 0;
  let offset = 0;
  while (offset < length) {
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(counter, 0);
    const digest = createHash(hash).update(seed).update(counterBuf).digest();
    digest.copy(out, offset, 0, Math.min(hLen, length - offset));
    offset += hLen;
    counter += 1;
  }
  return out;
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

/**
 * OAEP decode with independent digest and MGF1 hashes.
 * Java's `RSA/ECB/OAEPWithSHA-256AndMGF1Padding` defaults MGF1 to SHA-1, which
 * Node's `oaepHash` option cannot express (it uses one hash for both).
 */
export function oaepDecode(em: Buffer, digestHash: 'sha1' | 'sha256', mgf1Hash: 'sha1' | 'sha256'): string | null {
  const hLen = digestHash === 'sha256' ? 32 : 20;
  if (em.length < 2 * hLen + 2 || em[0] !== 0x00) return null;
  const maskedSeed = em.subarray(1, 1 + hLen);
  const maskedDB = em.subarray(1 + hLen);
  const seed = xor(maskedSeed, mgf1(maskedDB, hLen, mgf1Hash));
  const db = xor(maskedDB, mgf1(seed, maskedDB.length, mgf1Hash));
  const lHash = createHash(digestHash).update(Buffer.alloc(0)).digest();
  if (!db.subarray(0, hLen).equals(lHash)) return null;
  let index = hLen;
  while (index < db.length && db[index] === 0x00) index += 1;
  if (index >= db.length || db[index] !== 0x01) return null;
  return db.subarray(index + 1).toString('utf8');
}

function tryOaepVariants(ciphertext: Buffer, keyPem: string): { code: string; method: 'oaep-sha256' | 'oaep-sha1' } | null {
  let em: Buffer;
  try {
    em = privateDecrypt({ key: keyPem, padding: constants.RSA_NO_PADDING }, ciphertext);
  } catch {
    return null;
  }
  const variants: Array<{ digest: 'sha1' | 'sha256'; mgf1: 'sha1' | 'sha256'; method: 'oaep-sha256' | 'oaep-sha1' }> = [
    { digest: 'sha256', mgf1: 'sha1', method: 'oaep-sha256' },
    { digest: 'sha1', mgf1: 'sha1', method: 'oaep-sha1' },
    { digest: 'sha256', mgf1: 'sha256', method: 'oaep-sha256' },
  ];
  for (const variant of variants) {
    const plain = oaepDecode(em, variant.digest, variant.mgf1);
    if (plain !== null) return { code: plain, method: variant.method };
  }
  return null;
}

export function decryptValidationCode(
  validationCode: string,
  privateKeyPem: string,
  publicKeyFingerprint?: string,
): {
  code: string;
  decryption: DigikalaDecryption;
} {
  const candidates = ciphertextCandidates(validationCode);
  if (candidates.length === 0) throw new Error('validation code is empty or not valid base64');

  const unwrap = (plain: string, decryption: DigikalaDecryption): { code: string; decryption: DigikalaDecryption } => {
    const trimmed = plain.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner = parsed['code'] ?? parsed['validation_code'] ?? parsed['token'] ?? parsed['authorization_code'];
        if (typeof inner === 'string' && inner.length > 0) return { code: inner, decryption };
      } catch {
        /* not JSON — use the raw plaintext */
      }
    }
    return { code: trimmed, decryption };
  };

  const attempts: string[] = [];
  for (const candidate of candidates) {
    // Node 20.12+/22 removed RSA_PKCS1_PADDING for privateDecrypt, and Digikala
    // encrypts the authorization code with PKCS#1 v1.5 — so the manual
    // RSA_NO_PADDING + unpad path must run FIRST. The pure-`privateDecrypt`
    // OAEP attempts below stay as fallbacks for panels that use OAEP.
    attempts.push(`pkcs1-manual:${candidate.label}`);
    const manualPkcs1 = tryManualPkcs1(candidate.bytes, privateKeyPem);
    if (manualPkcs1 !== null && manualPkcs1.trim().length > 0) {
      return unwrap(manualPkcs1, 'pkcs1');
    }

    attempts.push(`oaep-manual:${candidate.label}`);
    const manualOaep = tryOaepVariants(candidate.bytes, privateKeyPem);
    if (manualOaep !== null && manualOaep.code.trim().length > 0) {
      return unwrap(manualOaep.code, manualOaep.method);
    }

    for (const method of DECRYPTION_METHODS) {
      attempts.push(`${method.name}:${candidate.label}`);
      try {
        const options =
          method.oaepHash === undefined
            ? { key: privateKeyPem, padding: method.padding }
            : { key: privateKeyPem, padding: method.padding, oaepHash: method.oaepHash };
        const plain = privateDecrypt(options, candidate.bytes).toString('utf8');
        if (plain.trim().length === 0) continue;
        return unwrap(plain, method.name);
      } catch {
        /* try the next padding / encoding combination */
      }
    }
  }

  throw new RsaDecryptionError(publicKeyFingerprint ?? null, attempts);
}

function pickTokens(body: Record<string, unknown>): { accessToken: string; refreshToken: string | null; expiresIn: number | null } | null {
  const nested =
    typeof body['data'] === 'object' && body['data'] !== null ? (body['data'] as Record<string, unknown>) : body;
  const access =
    (nested['access_token'] ?? nested['accessToken'] ?? body['access_token'] ?? body['accessToken']) as unknown;
  if (typeof access !== 'string' || access.length === 0) return null;
  const refresh = (nested['refresh_token'] ?? nested['refreshToken'] ?? body['refresh_token']) as unknown;
  const expires = (nested['expires_in'] ?? nested['expiresIn']) as unknown;
  return {
    accessToken: access,
    refreshToken: typeof refresh === 'string' ? refresh : null,
    expiresIn: typeof expires === 'number' ? expires : null,
  };
}

export async function activateDigikalaToken(input: DigikalaActivationInput): Promise<DigikalaActivationResult> {
  const { code, decryption } = decryptValidationCode(
    input.validationCode,
    input.privateKeyPem,
    input.publicKeyFingerprint,
  );
  const base = (input.baseUrl ?? 'https://seller.digikala.com/open-api/v1').replace(/\/$/, '');
  const endpoint = `${base}/auth/token`;

  // Spec (seller.digikala.com/open-api/v1/doc): exactly one payload shape.
  // Sending the same single-use authorization_code across multiple fallback
  // shapes consumes it on the first successful call and makes every retry fail
  // with "seller.service.token.not.found". Post once, parse, stop.
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ authorization_code: code }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  const tokens = pickTokens(parsed);
  if (!response.ok || tokens === null) {
    throw new Error(`Digikala token rejected → HTTP ${response.status} ${text.slice(0, 400)}`);
  }
  return {
    ...tokens,
    decryption,
    endpoint,
    payloadVariant: 'authorization_code',
    raw: parsed,
  };
}
