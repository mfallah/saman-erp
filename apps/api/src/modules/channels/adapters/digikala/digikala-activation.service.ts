/**
 * Digikala token activation.
 *
 * Digikala's seller panel shows a base64 "validation code" (short-lived) and a
 * "client code". The seller must base64-decode the validation code, decrypt it
 * with their RSA private key, and POST the plaintext to `/open-api/v1/auth/token`
 * to receive access/refresh tokens.
 *
 * The exact JSON field names are not published consistently, so we try the
 * documented variants in order and return the first successful response.
 */
import { constants, privateDecrypt } from 'node:crypto';

export interface DigikalaActivationInput {
  readonly validationCode: string;
  readonly clientCode?: string;
  readonly clientSecret?: string;
  readonly privateKeyPem: string;
  readonly baseUrl?: string;
}

export interface DigikalaActivationResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number | null;
  readonly decryption: 'pkcs1' | 'oaep';
  readonly endpoint: string;
  readonly payloadVariant: string;
  readonly raw: Record<string, unknown>;
}

function tryDecrypt(ciphertext: Buffer, key: string, padding: number): string | null {
  try {
    const plain = privateDecrypt({ key, padding }, ciphertext);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

export function decryptValidationCode(validationCode: string, privateKeyPem: string): {
  code: string;
  decryption: 'pkcs1' | 'oaep';
} {
  const cleaned = validationCode.replace(/\s+/g, '');
  const ciphertext = Buffer.from(cleaned, 'base64');
  if (ciphertext.length === 0) throw new Error('validation code is empty or not valid base64');

  const unwrap = (plain: string, decryption: 'pkcs1' | 'oaep'): { code: string; decryption: 'pkcs1' | 'oaep' } => {
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
    return { code: plain, decryption };
  };

  const pkcs1 = tryDecrypt(ciphertext, privateKeyPem, constants.RSA_PKCS1_PADDING);
  if (pkcs1 !== null) return unwrap(pkcs1, 'pkcs1');

  const oaep = tryDecrypt(ciphertext, privateKeyPem, constants.RSA_PKCS1_OAEP_PADDING);
  if (oaep !== null) return unwrap(oaep, 'oaep');

  throw new Error('RSA decryption failed: the validation code does not match this private key');
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
  const { code, decryption } = decryptValidationCode(input.validationCode, input.privateKeyPem);
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
