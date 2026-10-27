/**
 * Digikala adapter — OAuth2 client-credentials, real `/open-api/v1` paths.
 *
 * Endpoint *paths* are contract-confirmed (264-endpoint catalog). Payload
 * schemas that the supplied document does not contain are constants under
 * `TBD_DIGIKALA` and blocked behind `DIGIKALA_TBD_ENABLED` (sandbox only).
 */
import { createHash } from 'node:crypto';

import type {
  AdapterAccount,
  AuthResult,
  BatchItemFailure,
  BatchResult,
  CanonicalOrder,
  CanonicalOrderLine,
  Capability,
  ChannelCode,
  InventoryUpdate,
  PriceUpdate,
  SettlementSummary,
  ShipmentUpdate,
  WebhookVerdict,
  WebhookVerifyInput,
} from '../../domain/channel.types';
import { IntegrationError } from '../../domain/channel.types';
import { hashPii } from '../../domain/pii';
import { decryptRsaOaep } from '../../domain/rsa-keypair';
import { verifyWebhook, WEBHOOK_SIGNATURE_CONFIG } from '../../domain/webhook-signature';
import type {
  ChannelAdapter,
  ExternalProduct,
  ExternalProductCatalogEntry,
  ExternalProductVariant,
} from '../../ports/channel-adapter.port';
import type { AppLogger } from '../../ports/logger.port';
import type { KeyValueStore } from '../../ports/key-value.port';
import type { PartnerHttpClient, PartnerResponse } from '../../infrastructure/partner-http.client';
import {
  DIGIKALA_CAPABILITIES,
  DIGIKALA_HOSTS,
  DIGIKALA_PATHS,
  DIGIKALA_PROD_BASE,
  DIGIKALA_SANDBOX_BASE,
  TBD_DIGIKALA,
} from './digikala.constants';
import { DigikalaTokenCache, type DigikalaTokenSet } from './digikala.token-cache';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayPayload(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const body = record(json);
  for (const key of ['data', 'items', 'results', 'orders', 'invoices', 'commissions']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}


/** Deep-searches a commission payload for a percentage value (0..100). */
function findPercent(value: unknown, depth = 0): number | null {
  if (depth > 4) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 && /%|percent|commission|rate/i.test(value)) return parsed;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPercent(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(obj)) {
      if (/percent|percentage|rate|commission/i.test(key)) {
        const found = findPercent(inner, depth + 1);
        if (found !== null) return found;
      }
    }
    for (const inner of Object.values(obj)) {
      const found = findPercent(inner, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function orderItems(json: unknown): unknown[] {
  const body = record(json);
  const data = record(body['data']);
  for (const key of ['items', 'orders', 'results']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return arrayPayload(json);
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Finds the first product/items array in the common seller-list envelopes. */
function productArrayPayload(json: unknown): unknown[] {
  const walk = (value: unknown, depth: number): unknown[] | null => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'object' || value === null || depth > 2) return null;
    const body = value as Record<string, unknown>;
    for (const key of ['products', 'items', 'data', 'results']) {
      const found = walk(body[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(json, 0) ?? [];
}

/** Hard cap on variant lookups per product; Digikala products are 1–n variants. */
const MAX_VARIANTS_PER_PRODUCT = 3;

/** Fields only a Digikala *variant* carries (never a product or an attribute). */
const VARIANT_MARKER_KEYS = ['supplier_code', 'seller_sku', 'seller_stock', 'variant_id'] as const;

/** Weaker variant signals, used in combination to avoid attribute rows. */
const VARIANT_HINT_KEYS = [
  'supplier_code',
  'seller_sku',
  'sku',
  'seller_stock',
  'selling_price',
  'buy_price',
  'packaging',
  'weight',
  'is_active',
  'max_sale',
  'barcode',
] as const;

interface DigikalaVariantRef {
  readonly id: string;
  readonly supplierCode: string | null;
}

/** Digikala ids are numeric; anything else is not a variant id. */
function variantIdOf(body: Record<string, unknown>): string | null {
  const candidate = stringValue(body['variant_id']) ?? stringValue(body['id']);
  if (candidate === null) return null;
  const trimmed = candidate.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function variantSupplierCode(body: Record<string, unknown>): string | null {
  return (
    stringValue(body['supplier_code']) ??
    stringValue(body['seller_sku']) ??
    stringValue(body['sku'])
  );
}

/**
 * Collects real variant ids from an untyped Digikala payload.
 *
 * `/product-edit/{product_id}` and `/variants/creation/{product_id}` nest their
 * variant arrays differently (`data.variants`, `data.product.variants`,
 * `data[]`, …), so any nested object with a **numeric** id and variant-ish
 * fields counts. `excludeId` drops the enclosing product row: its own id is a
 * product id and must never be mistaken for a variant id.
 */
function collectVariants(json: unknown, excludeId: string): DigikalaVariantRef[] {
  const found = new Map<string, DigikalaVariantRef>();
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    const body = value as Record<string, unknown>;
    const id = variantIdOf(body);
    if (id !== null && id !== excludeId) {
      const marker = VARIANT_MARKER_KEYS.some((markerKey) => body[markerKey] !== undefined);
      const hints = VARIANT_HINT_KEYS.filter((hintKey) => body[hintKey] !== undefined).length;
      const underVariantKey = /variant/i.test(key);
      if (marker || hints >= 2 || (underVariantKey && hints >= 1)) {
        if (!found.has(id)) found.set(id, { id, supplierCode: variantSupplierCode(body) });
      }
    }
    for (const [childKey, child] of Object.entries(body)) {
      if (typeof child === 'object') visit(child, childKey, depth + 1);
    }
  };
  visit(json, '', 0);
  return [...found.values()];
}

/** Product title across the seller-list envelopes (`title`/`name`/nested product). */
function productTitleOf(raw: unknown, fallback: string): string {
  const body = record(raw);
  const product = record(body['product']);
  const title =
    stringValue(body['title']) ??
    stringValue(body['name']) ??
    stringValue(product['title']) ??
    stringValue(product['name']) ??
    fallback;
  return title.trim();
}

/** Keys that carry a product image directly or as an image container. */
const IMAGE_KEYS = ['image_src', 'image_url', 'image', 'images', 'thumbnail', 'photo'] as const;
/** Containers worth descending into while looking for an image. */
const IMAGE_CONTAINER_KEYS = [
  ...IMAGE_KEYS,
  'product',
  'data',
  'item',
  'items',
  'variant',
  'variants',
] as const;

/** Absolute http(s) URL only: a relative/`data:` value is not usable as-is. */
function normaliseImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 1000);
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Product image across the seller-list envelopes: the row-level `image_src`
 * wins, then the nested `product.image` (a string, or an object/array whose
 * `url`/`src` holds the link). Bounded walk; anything else is ignored.
 */
function productImageUrlOf(raw: unknown): string | null {
  const body = record(raw);
  const product = record(body['product']);
  const direct =
    normaliseImageUrl(body['image_src']) ??
    normaliseImageUrl(body['image_url']) ??
    normaliseImageUrl(product['image_src']) ??
    normaliseImageUrl(product['image_url']);
  if (direct !== null) return direct;

  const walk = (value: unknown, depth: number, insideImage: boolean): string | null => {
    if (depth > 6 || value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1, insideImage);
        if (found !== null) return found;
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    const keys = insideImage ? [...IMAGE_KEYS, 'url', 'src'] : IMAGE_KEYS;
    for (const key of keys) {
      const found = normaliseImageUrl(obj[key]);
      if (found !== null) return found;
    }
    for (const key of IMAGE_CONTAINER_KEYS) {
      const inner = walk(obj[key], depth + 1, (IMAGE_KEYS as readonly string[]).includes(key));
      if (inner !== null) return inner;
    }
    return null;
  };
  return walk(body, 0, false) ?? walk(product, 0, true);
}

/** Digikala product id from a seller-list row (`product_id` wins over row `id`). */
function productIdOf(raw: unknown): string | null {
  const body = record(raw);
  const product = record(body['product']);
  return (
    stringValue(body['product_id']) ??
    stringValue(product['product_id']) ??
    stringValue(product['id']) ??
    stringValue(body['id']) ??
    stringValue(body['uuid'])
  );
}

export class DigikalaAdapter implements ChannelAdapter {
  readonly code: ChannelCode = 'digikala';
  readonly capabilities: ReadonlySet<Capability> = new Set(DIGIKALA_CAPABILITIES);
  readonly declaredHosts = DIGIKALA_HOSTS;
  private readonly tokens: DigikalaTokenCache;

  constructor(
    private readonly deps: {
      readonly http: PartnerHttpClient;
      readonly store: KeyValueStore;
      readonly logger: AppLogger;
      readonly tbdEnabled?: boolean;
    },
  ) {
    this.tokens = new DigikalaTokenCache(deps.store);
  }

  baseUrlFor(sandbox: boolean): string {
    return sandbox ? DIGIKALA_SANDBOX_BASE : DIGIKALA_PROD_BASE;
  }

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  private tbdEnabled(): boolean {
    return this.deps.tbdEnabled ?? process.env.DIGIKALA_TBD_ENABLED === 'true';
  }

  private requireTbd(feature: string): void {
    if (!this.tbdEnabled()) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'این بخش از قرارداد دیجی‌کالا هنوز در محیط آزمایشی تأیید نشده است.',
        details: { feature },
      });
    }
  }

  private credentials(account: AdapterAccount): { clientId: string; clientSecret: string } {
    const clientId = account.credentials['client_id'] ?? account.credentials['client_code'];
    const clientSecret = account.credentials['client_secret'];
    if (clientId === undefined || clientSecret === undefined) {
      throw new IntegrationError('UNAUTHENTICATED', {
        messageFa: 'اعتبارنامهٔ OAuth دیجی‌کالا تنظیم نشده است.',
      });
    }
    return { clientId, clientSecret };
  }

  private async loadToken(account: AdapterAccount, forceRefresh = false): Promise<DigikalaTokenSet> {
    if (!forceRefresh) {
      const cached = await this.tokens.get(account.id);
      if (cached !== null) return cached;
      // Panel activation already stored a usable access token; use it directly
      // instead of trying the client_credentials grant (which needs a separate
      // client_id/client_secret the panel flow does not provide).
      const stored = account.credentials['access_token'];
      if (stored !== undefined && stored.length > 0) {
        const token: DigikalaTokenSet = {
          accessToken: stored,
          refreshToken: account.credentials['refresh_token'] ?? null,
          expiresAt: Date.now() + 3600 * 1000,
        };
        await this.tokens.set(account.id, token);
        return token;
      }
    }
    return this.tokens.getOrLoad(account.id, async () => {
      const { clientId, clientSecret } = this.credentials(account);
      const response = await this.deps.http.request(account, {
        operation: 'digikala.auth.token',
        method: 'POST',
        path: DIGIKALA_PATHS.token,
        body: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
        authHeaders: {},
        maxAttempts: 2,
        idempotent: true,
      });
      return this.readToken(response, null, account);
    });
  }

  private async refresh(account: AdapterAccount): Promise<DigikalaTokenSet> {
    const current = await this.tokens.get(account.id);
    await this.tokens.invalidate(account.id);
    if (current?.refreshToken === null || current?.refreshToken === undefined) {
      return this.loadToken(account, true);
    }
    try {
      const response = await this.deps.http.request(account, {
        operation: 'digikala.auth.refresh',
        method: 'POST',
        path: DIGIKALA_PATHS.refreshToken,
        body: { access_token: current.accessToken, refresh_token: current.refreshToken },
        authHeaders: {},
        maxAttempts: 1,
      });
      const token = this.readToken(response, current.refreshToken, account);
      await this.tokens.set(account.id, token);
      return token;
    } catch (error) {
      this.deps.logger.warn(
        { accountId: account.id, error: error instanceof Error ? error.message : 'refresh_failed' },
        'digikala refresh failed; falling back to client credentials',
      );
      return this.loadToken(account, true);
    }
  }

  private readToken(
    response: PartnerResponse,
    previousRefresh: string | null,
    account: AdapterAccount,
  ): DigikalaTokenSet {
    // Digikala wraps the token payload in `data`
    // ({ status:'ok', data:{ access_token, refresh_token, expires_in } }).
    const outer = record(response.json);
    const inner = record(outer['data']);
    const payload = Object.keys(inner).length > 0 ? inner : outer;
    const body = this.decryptTokenBody(payload, account);
    const accessToken = stringValue(body['access_token']);
    const expiresIn = Number(body['expires_in'] ?? 7200);
    if (accessToken === null) {
      throw new IntegrationError('UPSTREAM_INVALID_RESPONSE', {
        messageFa: 'پاسخ احراز هویت دیجی‌کالا معتبر نبود.',
        retryable: true,
      });
    }
    return {
      accessToken,
      refreshToken: stringValue(body['refresh_token']) ?? previousRefresh,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    };
  }

  /**
   * Digikala may return the token encrypted with the seller's RSA public key
   * (`encrypted_token` / `access_token_encrypted`). Decrypt with the stored
   * private key; on any failure fall back to the plain `access_token`.
   */
  private decryptTokenBody(
    body: Record<string, unknown>,
    account: AdapterAccount,
  ): Record<string, unknown> {
    const encrypted =
      stringValue(body['encrypted_token']) ?? stringValue(body['access_token_encrypted']);
    if (encrypted === null) return body;
    const privateKeyPem = account.credentials['private_key'];
    if (privateKeyPem === undefined) {
      this.deps.logger.warn(
        { accountId: account.id },
        'digikala returned an encrypted token but no RSA private key is stored; using plain token',
      );
      return body;
    }
    try {
      const plaintext = decryptRsaOaep(privateKeyPem, encrypted).trim();
      if (plaintext.startsWith('{')) {
        const nested = record(JSON.parse(plaintext) as unknown);
        const nestedToken = stringValue(nested['access_token']) ?? stringValue(nested['token']);
        if (nestedToken !== null) {
          return {
            ...body,
            access_token: nestedToken,
            ...(stringValue(nested['refresh_token']) === null
              ? {}
              : { refresh_token: stringValue(nested['refresh_token']) }),
          };
        }
      }
      if (plaintext.length > 0) return { ...body, access_token: plaintext };
      return body;
    } catch (error) {
      this.deps.logger.warn(
        { accountId: account.id, error: error instanceof Error ? error.message : 'decrypt_failed' },
        'digikala token decryption failed; falling back to plain token',
      );
      return body;
    }
  }

  /** Runs a request with a token, refreshing once on 401 (API.md §8.3). */
  private async withAuth<T>(
    account: AdapterAccount,
    fn: (authHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const token = await this.loadToken(account);
    try {
      return await fn({ authorization: `Bearer ${token.accessToken}` });
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.code !== 'UNAUTHENTICATED') throw error;
      const refreshed = await this.refresh(account);
      return fn({ authorization: `Bearer ${refreshed.accessToken}` });
    }
  }

  /**
   * Live commission percentage for one Digikala product (the rate differs per
   * category and is not fixed at listing time).
   */
  async fetchProductCommission(
    account: AdapterAccount,
    productId: string,
  ): Promise<{ percent: number | null; raw: Record<string, unknown> }> {
    const response = await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.commission.product',
        method: 'GET',
        path: DIGIKALA_PATHS.beSeller(String(productId)),
        authHeaders,
      }),
    );
    const body = record(response.json);
    const data = record(body['data']);
    const percent = findPercent(data['commission']) ?? findPercent(record(data['commission'])) ?? findPercent(data);
    return { percent, raw: data };
  }

  async authenticate(account: AdapterAccount): Promise<AuthResult> {
    const started = Date.now();
    // The http client now sets the Digikala-mandated
    // `User-Agent: DigikalaTrustedBot/SelfToken/<seller_code>` automatically.
    await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.health',
        method: 'GET',
        path: DIGIKALA_PATHS.health,
        authHeaders,
        maxAttempts: 1,
      }),
    );
    return { ok: true, scopes: [], latencyMs: Date.now() - started };
  }

  healthCheck(account: AdapterAccount): Promise<AuthResult> {
    return this.authenticate(account);
  }

  async pushInventory(
    account: AdapterAccount,
    items: readonly InventoryUpdate[],
  ): Promise<BatchResult> {
    const failures: BatchItemFailure[] = [];
    const valid: Array<{ variantId: number; stock: number; externalId: string }> = [];
    for (const item of items) {
      const variantId = Number(item.externalVariantId);
      const stock = Math.max(0, Math.trunc(Number(item.available)));
      if (!Number.isFinite(variantId) || variantId <= 0 || !Number.isFinite(stock)) {
        failures.push({
          externalId: item.externalVariantId,
          code: 'MAPPING_REQUIRED',
          messageFa: 'شناسهٔ عددی تنوع برای دیجی‌کالا معتبر نیست.',
          retryable: false,
        });
        continue;
      }
      valid.push({ variantId, stock, externalId: item.externalVariantId });
    }
    if (valid.length === 0) return { ok: failures.length === 0, succeeded: 0, failed: failures };
    // Digikala caps the batch endpoint at 50 items per request.
    let succeeded = 0;
    for (let offset = 0; offset < valid.length; offset += 50) {
      const chunk = valid.slice(offset, offset + 50);
      try {
        await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: 'digikala.stock.batch',
            method: 'POST',
            path: DIGIKALA_PATHS.bulkSellerStock,
            authHeaders,
            body: {
              items: chunk.map((row) => ({
                variant_id: row.variantId,
                payload: { seller_stock: row.stock },
              })),
            },
            idempotent: true,
          }),
        );
        succeeded += chunk.length;
      } catch (error) {
        const failure = this.toFailure(chunk[0]?.externalId ?? 'batch', error);
        for (const row of chunk) failures.push({ ...failure, externalId: row.externalId });
      }
    }
    return { ok: failures.length === 0, succeeded, failed: failures };
  }

  async pushPrices(account: AdapterAccount, items: readonly PriceUpdate[]): Promise<BatchResult> {
    const failures: BatchItemFailure[] = [];
    let succeeded = 0;
    for (const item of items) {
      const variantId = Number(item.externalVariantId);
      const price = Number(item.value.price);
      if (!Number.isFinite(variantId) || variantId <= 0 || !Number.isFinite(price) || price <= 0) {
        failures.push({
          externalId: item.externalVariantId,
          code: 'MAPPING_REQUIRED',
          messageFa: 'شناسهٔ تنوع یا قیمت برای دیجی‌کالا معتبر نیست.',
          retryable: false,
        });
        continue;
      }
      try {
        await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: 'digikala.price.update',
            method: 'PATCH',
            path: DIGIKALA_PATHS.sellingPrice,
            authHeaders,
            body: { variant_id: variantId, selling_price: Math.round(price) },
            idempotent: true,
          }),
        );
        succeeded += 1;
      } catch (error) {
        failures.push(this.toFailure(item.externalVariantId, error));
      }
    }
    return { ok: failures.length === 0, succeeded, failed: failures };
  }

  async *pullOrders(account: AdapterAccount, since: Date): AsyncIterable<CanonicalOrder> {
    const size = 50;
    // Two different order streams: DK-fulfilled `/orders` and seller-fulfilled
    // `/ship-by-seller-orders`. Both are canonicalised into the same shape.
    const streams: Array<{ path: string; operation: string; query: Record<string, string | number> }> = [
      { path: DIGIKALA_PATHS.orders, operation: 'digikala.orders.dk', query: { sort: 'order_created_at', order: 'desc' } },
      { path: DIGIKALA_PATHS.sbsOrders, operation: 'digikala.orders.sbs', query: { sort: 'order_date', order: 'desc' } },
    ];
    for (const stream of streams) {
      const isDk = stream.path === DIGIKALA_PATHS.orders;
      const grouped = new Map<string, CanonicalOrder>();
      for (let page = 1; page <= 20; page += 1) {
        let response;
        try {
          response = await this.withAuth(account, (authHeaders) =>
            this.deps.http.request(account, {
              operation: stream.operation,
              method: 'GET',
              path: stream.path,
              query: { page, size, ...stream.query },
              authHeaders,
            }),
          );
        } catch (error) {
          this.deps.logger.warn(
            { accountId: account.id, stream: stream.operation, error: error instanceof Error ? error.message : 'failed' },
            'digikala order stream failed; continuing with the next stream',
          );
          break;
        }
        const rows = orderItems(response.json);
        if (isDk) {
          // DK `/orders` returns one row per order *item*; group by order id.
          for (const raw of rows) {
            const item = this.mapOrderItem(raw);
            if (item === null) continue;
            const existing = grouped.get(item.orderId);
            if (existing === undefined) {
              grouped.set(item.orderId, item.order);
            } else {
              const merged: CanonicalOrder = {
                ...existing,
                lines: [...existing.lines, ...item.order.lines],
                totals: {
                  itemsTotal: String(BigInt(existing.totals.itemsTotal || '0') + BigInt(item.order.totals.itemsTotal || '0')),
                  shipping: existing.totals.shipping,
                  discount: String(BigInt(existing.totals.discount || '0') + BigInt(item.order.totals.discount || '0')),
                  grandTotal: String(BigInt(existing.totals.grandTotal || '0') + BigInt(item.order.totals.grandTotal || '0')),
                },
              };
              grouped.set(item.orderId, merged);
            }
          }
        } else {
          for (const raw of rows) {
            const order = this.mapOrder(raw);
            if (order.placedAt.getTime() >= since.getTime()) yield order;
          }
        }
        if (rows.length < size) break;
      }
      if (isDk) {
        // Order items identify a *variant*; our mappings are keyed by DK
        // *product* id, so resolve variant → product once per pull run.
        const productByVariant = new Map<string, { productId: string | null; supplierCode: string | null; productTitle: string | null }>();
        const resolveProduct = async (variantId: string): Promise<{ productId: string | null; supplierCode: string | null; productTitle: string | null }> => {
          const cached = productByVariant.get(variantId);
          if (cached !== undefined) return cached;
          let productId: string | null = null;
          let supplierCode: string | null = null;
          let productTitle: string | null = null;
          try {
            const response = await this.withAuth(account, (authHeaders) =>
              this.deps.http.request(account, {
                operation: 'digikala.variants.get',
                method: 'GET',
                path: DIGIKALA_PATHS.variant(variantId),
                authHeaders,
              }),
            );
            const body = record(response.json);
            const data = record(body['data']);
            productId =
              stringValue(data['product_id']) ??
              stringValue(record(data['product'])['id']) ??
              stringValue(body['product_id']);
            supplierCode = stringValue(data['supplier_code']);
            productTitle = stringValue(data['product_title']) ?? stringValue(data['title']);
          } catch {
            productId = null;
          }
          const resolved = { productId, supplierCode, productTitle };
          productByVariant.set(variantId, resolved);
          return resolved;
        };
        for (const order of grouped.values()) {
          const lines = [];
          for (const line of order.lines) {
            const variantId = line.externalVariantId;
            if (variantId === undefined) {
              lines.push(line);
              continue;
            }
            const resolved = await resolveProduct(variantId);
            lines.push({
              ...line,
              ...(resolved.productId === null ? {} : { externalProductId: resolved.productId }),
              ...(resolved.supplierCode === null ? {} : { externalSku: resolved.supplierCode }),
              ...(resolved.productTitle === null ? {} : { externalProductTitle: resolved.productTitle }),
            });
          }
          const enriched: CanonicalOrder = { ...order, lines };
          if (enriched.placedAt.getTime() >= since.getTime()) yield enriched;
        }
      }
    }
  }

  /** DK `/orders` rows are flat order *items* (one row per line). */
  private mapOrderItem(raw: unknown): { orderId: string; order: CanonicalOrder } | null {
    const body = record(raw);
    const orderId = stringValue(body['order_id']);
    const variantId = stringValue(body['product_variant_id']);
    if (orderId === null || variantId === null) return null;
    const quantity = stringValue(body['quantity']) ?? '0';
    const unitPrice = stringValue(body['selling_price']) ?? '0';
    const discount = stringValue(body['amazing_discount']) ?? '0';
    const placedAt = new Date(stringValue(body['order_created_at']) ?? Date.now());
    return {
      orderId,
      order: {
        externalOrderId: orderId,
        externalStatus: stringValue(body['status']) ?? 'unknown',
        placedAt,
        currency: 'IRR',
        lines: [
          {
            externalLineId: `${orderId}:${variantId}`,
            externalSku: stringValue(body['supplier_code']) ?? variantId,
            externalVariantId: variantId,
            quantity,
            unitPrice,
            discount,
          },
        ],
        totals: {
          itemsTotal: stringValue(body['total_price']) ?? unitPrice,
          shipping: '0',
          discount,
          grandTotal: stringValue(body['total_price']) ?? unitPrice,
        },
        customerRefHash: hashPii(JSON.stringify({ orderId })),
        shippingRefHash: hashPii(JSON.stringify({ orderId })),
        rawPayloadHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
      },
    };
  }

  private mapOrder(raw: unknown): CanonicalOrder {
    const body = record(raw);
    const externalOrderId =
      stringValue(body['shipment_id']) ?? stringValue(body['id']) ?? stringValue(body['order_id']);
    if (externalOrderId === null) {
      throw new IntegrationError('UPSTREAM_INVALID_RESPONSE', {
        messageFa: 'شناسهٔ سفارش در پاسخ دیجی‌کالا یافت نشد.',
        retryable: false,
      });
    }
    const rawLines = Array.isArray(body['items'])
      ? body['items']
      : Array.isArray(body['order_items'])
        ? body['order_items']
        : [];
    const lines: CanonicalOrderLine[] = rawLines.map((line, index) => {
      const item = record(line);
      return {
        externalLineId: stringValue(item['id']) ?? `${externalOrderId}:${index + 1}`,
        externalSku: stringValue(item['sku']) ?? stringValue(item['variant_id']) ?? '',
        ...(stringValue(item['variant_id']) === null
          ? {}
          : { externalVariantId: stringValue(item['variant_id']) as string }),
        quantity: stringValue(item['quantity']) ?? '0',
        unitPrice: stringValue(item['price']) ?? stringValue(item['unit_price']) ?? '0',
        discount: stringValue(item['discount']) ?? '0',
      };
    });
    const customer = record(body['customer']);
    const address = record(body['address']);
    return {
      externalOrderId,
      externalStatus: stringValue(body['status']) ?? 'unknown',
      placedAt: new Date(stringValue(body['created_at']) ?? stringValue(body['order_created_at']) ?? Date.now()),
      currency: 'IRR',
      lines,
      totals: {
        itemsTotal: stringValue(body['items_total']) ?? '0',
        shipping: stringValue(body['shipping_amount']) ?? '0',
        discount: stringValue(body['discount_amount']) ?? '0',
        grandTotal: stringValue(body['total']) ?? stringValue(body['grand_total']) ?? '0',
      },
      customerRefHash: hashPii(JSON.stringify(customer)),
      shippingRefHash: hashPii(JSON.stringify(address)),
      rawPayloadHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    };
  }

  async acknowledgeOrder(
    account: AdapterAccount,
    externalOrderId: string,
    status: string,
  ): Promise<void> {
    this.requireTbd(TBD_DIGIKALA.orderStatusEnum);
    await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.orders.status',
        method: 'PUT',
        path: DIGIKALA_PATHS.updateStatus,
        authHeaders,
        body: { shipment_id: externalOrderId, status },
      }),
    );
  }

  async updateShipment(account: AdapterAccount, update: ShipmentUpdate): Promise<void> {
    if (update.trackingCode !== undefined) {
      this.requireTbd(TBD_DIGIKALA.trackingCodePayload);
      await this.withAuth(account, (authHeaders) =>
        this.deps.http.request(account, {
          operation: 'digikala.shipment.tracking',
          method: 'POST',
          path: DIGIKALA_PATHS.trackingCode,
          authHeaders,
          body: {
            shipment_id: update.externalShipmentId ?? update.externalOrderId,
            tracking_code: update.trackingCode,
          },
        }),
      );
    }
    const statusMap: Record<ShipmentUpdate['status'], string> = {
      dispatched: 'sent',
      delivered: 'delivered',
      returned: 'returned',
      cancelled: 'cancelled',
    };
    await this.acknowledgeOrder(account, update.externalOrderId, statusMap[update.status]);
  }

  /** Reconciliation-only stock read (`GET /inventories/{product_variant_id}`). */
  async *pullInventory(
    account: AdapterAccount,
    refs: readonly { variantId: string; externalVariantId: string }[],
  ): AsyncIterable<{ variantId: string; available: string }> {
    for (const ref of refs) {
      const response = await this.withAuth(account, (authHeaders) =>
        this.deps.http.request(account, {
          operation: 'digikala.inventory.read',
          method: 'GET',
          path: `/inventories/${encodeURIComponent(ref.externalVariantId)}`,
          authHeaders,
        }),
      );
      const body = record(response.json);
      const available =
        stringValue(body['stock']) ??
        stringValue(body['available']) ??
        stringValue(record(body['data'])['stock']);
      if (available !== null) yield { variantId: ref.variantId, available };
    }
  }

  /**
   * Reads `GET /products/seller` page by page. `product_id` is the Digikala
   * *product* id and wins over the row `id` (which is not a variant id either);
   * a page never exceeds `perPage`, so a short page ends the walk.
   */
  private async *sellerProductRows(
    account: AdapterAccount,
    maxPages: number,
  ): AsyncIterable<unknown> {
    const perPage = 50;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.withAuth(account, (authHeaders) =>
        this.deps.http.request(account, {
          operation: 'digikala.products.list',
          method: 'GET',
          path: DIGIKALA_PATHS.sellerProducts,
          query: { page, per_page: perPage },
          authHeaders,
          idempotent: true,
        }),
      );
      const items = productArrayPayload(response.json);
      for (const raw of items) yield raw;
      if (items.length < perPage) return;
    }
  }

  /**
   * Real variant ids of one product. `/product-edit/{product_id}` carries the
   * variant list; when it answers without usable variants (or fails) the
   * `/variants/creation/{product_id}` list is used instead. Results are capped
   * at `MAX_VARIANTS_PER_PRODUCT` and memoised per run through `cache`.
   */
  private async variantsForProduct(
    account: AdapterAccount,
    productId: string,
    cache: Map<string, readonly DigikalaVariantRef[]>,
  ): Promise<readonly DigikalaVariantRef[]> {
    const cached = cache.get(productId);
    if (cached !== undefined) return cached;
    const attempts = [
      { operation: 'digikala.product.edit', path: DIGIKALA_PATHS.productEdit(productId) },
      { operation: 'digikala.variants.creation', path: DIGIKALA_PATHS.variantsOfProduct(productId) },
    ];
    let resolved: readonly DigikalaVariantRef[] = [];
    for (const attempt of attempts) {
      try {
        const response = await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: attempt.operation,
            method: 'GET',
            path: attempt.path,
            authHeaders,
            idempotent: true,
          }),
        );
        resolved = collectVariants(response.json, productId);
      } catch (error) {
        this.deps.logger.warn(
          {
            accountId: account.id,
            productId,
            operation: attempt.operation,
            error: error instanceof Error ? error.message : 'variant_lookup_failed',
          },
          'digikala variant lookup failed',
        );
        resolved = [];
      }
      if (resolved.length > 0) break;
    }
    const bounded = resolved.slice(0, MAX_VARIANTS_PER_PRODUCT);
    cache.set(productId, bounded);
    return bounded;
  }

  /**
   * Catalogue ids for the admin repair flow: `product_id` + title only, no
   * variant lookups (the caller resolves variants for the rows it will update).
   */
  async *listProductCatalog(
    account: AdapterAccount,
    options?: { readonly maxPages?: number },
  ): AsyncIterable<ExternalProductCatalogEntry> {
    for await (const raw of this.sellerProductRows(account, options?.maxPages ?? 10)) {
      const externalProductId = productIdOf(raw);
      if (externalProductId === null) continue;
      yield {
        externalProductId: externalProductId.trim(),
        title: productTitleOf(raw, externalProductId),
        raw,
      };
    }
  }

  /** Bounded variant list of one product, for the admin repair flow. */
  async listProductVariants(
    account: AdapterAccount,
    externalProductId: string,
  ): Promise<readonly ExternalProductVariant[]> {
    const variants = await this.variantsForProduct(
      account,
      externalProductId,
      new Map<string, readonly DigikalaVariantRef[]>(),
    );
    return variants.map((variant) => ({
      externalVariantId: variant.id,
      ...(variant.supplierCode === null ? {} : { sku: variant.supplierCode }),
    }));
  }

  /**
   * First-sync catalogue import from `GET /products/seller`. Each product is
   * mapped with the Digikala **product** id plus the **real variant** id read
   * from `/product-edit` (falling back to `/variants/creation`); the variant id
   * is what stock/price writes require, so the seller-list row id is never used
   * for it. Variant lookups are cached and capped per product for the run.
   */
  async *pullProducts(account: AdapterAccount): AsyncIterable<ExternalProduct> {
    const variantCache = new Map<string, readonly DigikalaVariantRef[]>();
    for await (const raw of this.sellerProductRows(account, 3)) {
      const externalProductId = productIdOf(raw);
      if (externalProductId === null) continue;
      const body = record(raw);
      const product = record(body['product']);

      const resolved = await this.variantsForProduct(account, externalProductId, variantCache);
      // The seller row may already embed a variant list; use it only when the
      // dedicated endpoints returned nothing.
      const variants = (
        resolved.length > 0 ? resolved : collectVariants(raw, externalProductId)
      ).slice(0, MAX_VARIANTS_PER_PRODUCT);
      const variant = variants[0];

      const title = productTitleOf(raw, externalProductId);
      const sku =
        variant?.supplierCode ??
        stringValue(body['sku']) ??
        stringValue(body['seller_sku']) ??
        stringValue(product['sku']);
      const barcode =
        stringValue(body['barcode']) ?? stringValue(body['ean']) ?? stringValue(product['barcode']);
      const price =
        stringValue(body['price']) ??
        stringValue(body['selling_price']) ??
        stringValue(body['sale_price']) ??
        stringValue(product['price']) ??
        stringValue(product['selling_price']);
      const available =
        stringValue(body['stock']) ??
        stringValue(body['available']) ??
        stringValue(body['inventory']) ??
        stringValue(product['stock']) ??
        stringValue(product['available']);
      const imageUrl = productImageUrlOf(raw);

      yield {
        externalProductId: externalProductId.trim(),
        ...(variant === undefined ? {} : { externalVariantId: variant.id }),
        title,
        ...(sku === null ? {} : { sku }),
        ...(barcode === null ? {} : { barcode }),
        ...(price === null ? {} : { price }),
        ...(available === null ? {} : { available }),
        ...(imageUrl === null ? {} : { imageUrl }),
        raw,
      };
    }
  }

  async *pullSettlements(account: AdapterAccount, since: Date): AsyncIterable<SettlementSummary> {
    this.requireTbd(TBD_DIGIKALA.settlementResponse);
    const response = await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.invoices.pull',
        method: 'GET',
        path: DIGIKALA_PATHS.invoices,
        query: { from: since.toISOString() },
        authHeaders,
      }),
    );
    for (const raw of arrayPayload(response.json)) {
      const body = record(raw);
      const externalId = stringValue(body['id']);
      if (externalId === null) continue;
      yield {
        externalId,
        periodStart: new Date(stringValue(body['period_start']) ?? since.toISOString()),
        periodEnd: new Date(stringValue(body['period_end']) ?? Date.now()),
        grossAmount: stringValue(body['gross_amount']) ?? '0',
        commissionAmount: stringValue(body['commission_amount']) ?? '0',
        netAmount: stringValue(body['net_amount']) ?? '0',
      };
    }
  }

  /** Label PDF bytes (`GET /shipping-services/label/{method}/{parcel}`). */
  async fetchLabel(
    account: AdapterAccount,
    registrationMethod: string,
    parcelNumber: string,
  ): Promise<Buffer> {
    const response = await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.label.fetch',
        method: 'GET',
        path: DIGIKALA_PATHS.label(registrationMethod, parcelNumber),
        authHeaders,
        responseType: 'binary',
      }),
    );
    return response.bytes ?? Buffer.alloc(0);
  }

  async listWebhookEventTypes(account: AdapterAccount): Promise<readonly string[]> {
    const response = await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.webhook.event-types',
        method: 'GET',
        path: DIGIKALA_PATHS.webhookEventTypes,
        authHeaders,
      }),
    );
    return arrayPayload(response.json)
      .map((item) => (typeof item === 'string' ? item : stringValue(record(item)['event'])))
      .filter((item): item is string => item !== null);
  }

  async subscribeWebhook(
    account: AdapterAccount,
    input: { url: string; eventTypes: readonly string[] },
  ): Promise<void> {
    this.requireTbd(TBD_DIGIKALA.webhookSubscriptionPayload);
    await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.webhook.subscribe',
        method: 'POST',
        path: DIGIKALA_PATHS.webhookSubscription,
        authHeaders,
        body: { url: input.url, event_types: input.eventTypes },
      }),
    );
  }

  async unsubscribeWebhook(account: AdapterAccount, url: string): Promise<void> {
    this.requireTbd(TBD_DIGIKALA.webhookSubscriptionPayload);
    await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.webhook.unsubscribe',
        method: 'POST',
        path: DIGIKALA_PATHS.webhookUnsubscription,
        authHeaders,
        body: { url },
      }),
    );
  }

  verifyWebhook(input: WebhookVerifyInput): WebhookVerdict {
    return verifyWebhook(input, { config: WEBHOOK_SIGNATURE_CONFIG.digikala });
  }

  private toFailure(externalId: string, error: unknown): BatchItemFailure {
    if (error instanceof IntegrationError) {
      return {
        externalId,
        code: error.code,
        messageFa: error.messageFa,
        retryable: error.retryable,
      };
    }
    return {
      externalId,
      code: 'UPSTREAM_UNAVAILABLE',
      messageFa: 'ارتباط با دیجی‌کالا برقرار نشد.',
      retryable: true,
    };
  }
}
