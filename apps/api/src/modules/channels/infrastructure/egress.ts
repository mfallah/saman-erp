/**
 * Egress guard (R1-security M-05 / ADR-0006 revision 4).
 *
 * Base URLs are **code-declared constants**. Environment may only choose a
 * declared sandbox/production variant; `channel_account.base_url` is ignored and
 * rejected when it does not match a declared host. This module also provides a
 * public-host check for outbound webhooks (H-04).
 */
import { isIP } from 'node:net';

export interface EgressTarget {
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

const ALLOWED_PORTS = new Set([443]);

export class EgressDeniedError extends Error {
  readonly rule: string;

  constructor(rule: string) {
    super(`egress_denied:${rule}`);
    this.name = 'EgressDeniedError';
    this.rule = rule;
  }
}

/** Parses and validates an outbound URL against an explicit host allowlist. */
export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[]): EgressTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressDeniedError('invalid_url');
  }
  if (url.protocol !== 'https:') throw new EgressDeniedError('https_required');
  if (url.username.length > 0 || url.password.length > 0) {
    throw new EgressDeniedError('userinfo_forbidden');
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) throw new EgressDeniedError('host_missing');
  if (isIP(host) !== 0) throw new EgressDeniedError('ip_literal_forbidden');
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) {
    throw new EgressDeniedError('host_malformed');
  }
  if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    throw new EgressDeniedError('host_not_allowlisted');
  }
  const port = url.port.length === 0 ? 443 : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) throw new EgressDeniedError('port_forbidden');
  return { url: url.toString(), host, port };
}

/** Declared adapter hosts (production + sandbox). No runtime additions. */
export const DECLARED_ADAPTER_HOSTS = {
  carexy: ['carexy.shop'],
  digikala: ['seller.digikala.com', 'seller-sandbox.digikala.com'],
  limo: ['api.limosms.com'],
} as const;

/** Seeded outbound-webhook destination allowlist (H-04). Change requires review. */
export const OUTBOUND_WEBHOOK_ALLOWED_HOSTS: readonly string[] = ['carexy.shop', 'www.carexy.shop'];

/** Boot assertion: every adapter base URL must sit on a declared host. */
export function assertDeclaredAdapterHosts(
  adapterCode: string,
  urls: readonly string[],
  declaredHosts: readonly string[],
): void {
  for (const raw of urls) {
    const target = assertAllowedUrl(raw, declaredHosts);
    if (!declaredHosts.includes(target.host)) {
      throw new Error(`adapter_host_not_declared:${adapterCode}:${target.host}`);
    }
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Rejects private/link-local/metadata addresses returned by DNS. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return PRIVATE_V4.some((pattern) => pattern.test(address)) || address === '255.255.255.255';
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);
  }
  return false;
}
