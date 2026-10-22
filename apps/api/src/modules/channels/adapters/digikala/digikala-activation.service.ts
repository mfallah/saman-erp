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
import { constants, privateDecrypt } from 'node:crypto';

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

  const variants: Array<{ name: string; body: Record<string, unknown>; headers?: Record<string, string>; form?: boolean }> = [];
  if (input.clientCode !== undefined && input.clientCode.length > 0) {
    if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
      const basic = Buffer.from(`${input.clientCode}:${input.clientSecret}`).toString('base64');
      variants.push({
        name: 'basic+form',
        body: { grant_type: 'authorization_code', code },
        headers: { authorization: `Basic ${basic}` },
        form: true,
      });
      variants.push({
        name: 'form+client_secret+code',
        body: { grant_type: 'authorization_code', client_id: input.clientCode, client_secret: input.clientSecret, code },
        form: true,
      });
      variants.push({
        name: 'basic+client_secret+code',
        body: { client_id: input.clientCode, client_secret: input.clientSecret, code },
        headers: { authorization: `Basic ${basic}` },
      });
      variants.push({
        name: 'client_secret+code',
        body: { client_id: input.clientCode, client_secret: input.clientSecret, code },
      });
      variants.push({
        name: 'authorization_code+secret',
        body: { grant_type: 'authorization_code', client_id: input.clientCode, client_secret: input.clientSecret, code },
      });
    }
    variants.push({ name: 'client_id+code', body: { client_id: input.clientCode, code } });
    variants.push({ name: 'client_code+code', body: { client_code: input.clientCode, code } });
    variants.push({
      name: 'authorization_code',
      body: { grant_type: 'authorization_code', client_id: input.clientCode, code },
    });
  }

  // The production endpoint expects the decrypted validation code in
  // `authorization_code`. These shapes are tried first because the live API
  // rejects `code`-only bodies with `authorization_code` required.
  const preferred: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'authorization_code', body: { authorization_code: code } },
  ];
  if (input.clientCode !== undefined && input.clientCode.length > 0) {
    preferred.push({
      name: 'authorization_code+client_code',
      body: { authorization_code: code, client_code: input.clientCode },
    });
  }
  variants.unshift(...preferred);
  variants.push({ name: 'code-only', body: { code } });

  const errors: string[] = [];
  for (const variant of variants) {
    try {
      const payload = variant.form === true ? new URLSearchParams(Object.entries(variant.body).map(([k, v]): [string, string] => [k, String(v)])) : JSON.stringify(variant.body);
      const contentType = variant.form === true ? 'application/x-www-form-urlencoded' : 'application/json';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': contentType, accept: 'application/json', ...(variant.headers ?? {}) },
        body: payload,
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      const tokens = pickTokens(parsed);
      if (response.ok && tokens !== null) {
        return {
          ...tokens,
          decryption,
          endpoint,
          payloadVariant: variant.name,
          raw: parsed,
        };
      }
      errors.push(`${variant.name}: HTTP ${response.status} ${text.slice(0, 160)}`);
      // A 401/422 on the first shape usually means the shape itself is wrong.
    } catch (error) {
      errors.push(`${variant.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Digikala token endpoint rejected every payload shape → ${errors.join(' | ')}`);
}
