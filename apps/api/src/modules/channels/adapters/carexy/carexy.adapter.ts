/**
 * Carexy adapter — `X-API-KEY`, contract-confirmed `/api/v1` endpoints.
 *
 * ERP is the source of truth: stock/price/product push, order pull and webhooks
 * are **TBD-CAREXY** (no documented endpoint, so no path is invented).
 */
import type {
  AdapterAccount,
  AuthResult,
  BatchItemFailure,
  BatchResult,
  CanonicalOrder,
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
import { verifyWebhook, WEBHOOK_SIGNATURE_CONFIG } from '../../domain/webhook-signature';
import type { ChannelAdapter, ExternalProduct } from '../../ports/channel-adapter.port';
import type { AppLogger } from '../../ports/logger.port';
import type { PartnerHttpClient, PartnerResponse } from '../../infrastructure/partner-http.client';
import type { ChannelMappingRepositoryPort } from '../../repositories/channel-mapping.repository';
import {
  CAREXY_BASE_URL,
  CAREXY_CAPABILITIES,
  CAREXY_HOSTS,
  CAREXY_PATHS,
  CAREXY_TBD,
} from './carexy.constants';
import {
  mapCarexyInventory,
  toCarexyInventoryWrite,
  type CarexyInventoryResponse,
  type CarexyInventorySnapshot,
} from './carexy.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Money/quantity as text; Carexy returns numbers and comma-grouped strings. */
function numeric(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[,\s]/g, '');
  if (cleaned.length === 0) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? String(parsed) : undefined;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** Raw sections that carry specification key/value pairs (Carexy shape varies). */
const ATTRIBUTE_SECTION_KEYS = [
  'attributes',
  'attribute',
  'specs',
  'specifications',
  'properties',
  'features',
] as const;
/** Fallback when the payload has no dedicated section: common scalar specs only. */
const ATTRIBUTE_FALLBACK_KEYS = [
  'color',
  'colour',
  'size',
  'material',
  'weight',
  'model',
  'warranty',
  'origin',
  'country',
  'manufacturer',
] as const;

/**
 * Flattens the attribute-ish parts of a product row into bounded scalar pairs.
 * Only named sections (or a small whitelist) are read, so an arbitrary payload
 * never lands in `products.attributes_json`. Returns `undefined` when empty.
 */
function collectAttributes(raw: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const put = (key: unknown, value: unknown): void => {
    const name = scalar(key);
    const text = scalar(value);
    if (name === undefined || text === undefined) return;
    if (Object.keys(out).length >= 50) return;
    out[name.slice(0, 80)] = text.slice(0, 500);
  };
  for (const sectionKey of ATTRIBUTE_SECTION_KEYS) {
    const section = raw[sectionKey];
    if (Array.isArray(section)) {
      for (const entry of section.slice(0, 50)) {
        if (!isRecord(entry)) continue;
        put(pick(entry, ['key', 'name', 'title', 'attribute', 'label']), pick(entry, ['value', 'text', 'name']));
      }
      continue;
    }
    if (!isRecord(section)) continue;
    for (const [key, value] of Object.entries(section).slice(0, 50)) {
      if (isRecord(value)) {
        put(key, pick(value, ['value', 'text', 'name', 'title']));
      } else if (Array.isArray(value)) {
        const joined = value
          .map((entry) => scalar(entry))
          .filter((entry): entry is string => entry !== undefined)
          .join(', ');
        if (joined.length > 0) put(key, joined);
      } else {
        put(key, value);
      }
    }
  }
  if (Object.keys(out).length === 0) {
    for (const key of ATTRIBUTE_FALLBACK_KEYS) {
      if (raw[key] === undefined) continue;
      put(key, raw[key]);
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

const LIST_KEYS = [
  'response',
  'data',
  'products',
  'items',
  'result',
  'results',
  'rows',
  'inventories',
] as const;
const STOCK_KEYS = ['stock', 'quantity', 'available', 'count', 'qty'] as const;

/**
 * `[…]`, `{response: {data: […]}}` (Carexy), `{data: {data|products|items: […]}}`
 * (Laravel-ish) or a numeric-keyed map — unwrapped recursively up to 4 levels.
 */
function listPayload(json: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(json)) return json;
  if (!isRecord(json)) return [];
  for (const key of LIST_KEYS) {
    if (!(key in json)) continue;
    const value = json[key];
    const nested = listPayload(value, depth + 1);
    if (nested.length > 0) return nested;
    // A present but empty array is an authoritative empty page.
    if (Array.isArray(value)) return [];
  }
  const keys = Object.keys(json);
  if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) return Object.values(json);
  return [];
}

/**
 * Carexy answers HTTP 200 even when the envelope reports failure
 * (`{success: false, code: 401}`), so the body — not the status — decides.
 */
function providerFailure(json: unknown): { code: string; httpStatus: number } | null {
  if (!isRecord(json)) return null;
  const success = json['success'];
  const envelopeCode = json['code'];
  const inner = json['response'];
  const codeValue = envelopeCode ?? (isRecord(inner) ? inner['code'] : undefined);
  const parsedCode =
    codeValue === undefined || codeValue === null ? undefined : Number(String(codeValue).trim());
  const failureCode =
    parsedCode !== undefined &&
    Number.isFinite(parsedCode) &&
    (parsedCode < 200 || parsedCode > 299);
  const failed = success === false || success === 'false' || success === 0 || success === '0';
  if (!failed && !failureCode) return null;
  const code = codeValue === undefined ? 'unknown' : String(codeValue);
  return { code, httpStatus: failureCode && parsedCode !== undefined ? parsedCode : 0 };
}

/** Envelope diagnostics only — key names and counts, never credentials or payloads. */
function logListEnvelope(page: number, json: unknown, items: readonly unknown[]): void {
  const envelope = isRecord(json) ? json : {};
  const inner = envelope['response'];
  const first = items[0];
  // eslint-disable-next-line no-console
  console.log(
    `[carexy] products page=${page} success=${String(envelope['success'])} code=${String(envelope['code'])} responseType=${typeof inner} responseKeys=${isRecord(inner) ? Object.keys(inner).join(',') : '-'} items=${items.length} firstItemKeys=${isRecord(first) ? Object.keys(first).slice(0, 20).join(',') : '-'}`,
  );
}

/** Sum of one stock field across inventory-like rows; `undefined` when absent. */
function sumStock(rows: readonly unknown[]): string | undefined {
  let total = 0;
  let found = false;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const value = numeric(pick(row, STOCK_KEYS));
    if (value === undefined) continue;
    total += Number(value);
    found = true;
  }
  return found ? String(total) : undefined;
}

export class CarexyAdapter implements ChannelAdapter {
  readonly code: ChannelCode = 'carexy';
  readonly capabilities: ReadonlySet<Capability> = new Set(CAREXY_CAPABILITIES);
  readonly declaredHosts = CAREXY_HOSTS;

  /**
   * Product → inventory list, cached per account for a few minutes.
   *
   * Carexy has no batch inventory write: one `PUT /inventories/update/{uuid}` per
   * inventory, and the uuid is only discoverable through
   * `GET /inventories/product/{product}`. Resolving that mapping on every push
   * doubled the request count and was the direct cause of the 429 storm, so the
   * lookup is memoised for the lifetime of a push run (and across jobs).
   */
  private readonly inventoryCache = new Map<
    string,
    { readonly expiresAt: number; readonly items: readonly CarexyInventorySnapshot[] }
  >();
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      readonly http: PartnerHttpClient;
      readonly mappings: ChannelMappingRepositoryPort;
      readonly logger: AppLogger;
    },
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  baseUrlFor(): string {
    // Carexy publishes a single declared production host; no free-form sandbox.
    return CAREXY_BASE_URL;
  }

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  private auth(account: AdapterAccount): Record<string, string> {
    const apiKey = account.credentials['api_key'];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new IntegrationError('UNAUTHENTICATED', {
        messageFa: 'کلید API کانال کرکسی تنظیم نشده است.',
      });
    }
    return { 'x-api-key': apiKey };
  }

  private userId(account: AdapterAccount): string {
    const value = account.settings['carexyUserId'];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number') return String(value);
    throw new IntegrationError('MAPPING_REQUIRED', {
      messageFa: 'شناسهٔ کاربری کرکسی برای این حساب تنظیم نشده است.',
      details: { field: 'carexyUserId' },
    });
  }

  async authenticate(account: AdapterAccount): Promise<AuthResult> {
    const started = Date.now();
    await this.deps.http.request(account, {
      operation: 'carexy.authenticate',
      method: 'GET',
      path: CAREXY_PATHS.products,
      query: { per_page: 1 },
      authHeaders: this.auth(account),
    });
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
    let succeeded = 0;
    for (const item of items) {
      try {
        const inventory = await this.resolveInventory(account, item);
        const body = toCarexyInventoryWrite({
          userId: this.userId(account),
          available: item.available,
          ...(item.price === undefined
            ? {}
            : {
                price: item.price.price,
                ...(item.price.discountPrice === undefined
                  ? {}
                  : { discountPrice: item.price.discountPrice }),
                ...(item.price.discountExpire === undefined
                  ? {}
                  : { discountExpire: item.price.discountExpire }),
              }),
          ...(item.weight === undefined ? {} : { weight: item.weight }),
          ...(item.variables === undefined ? {} : { variables: item.variables }),
        });
        await this.deps.http.request(account, {
          operation: 'carexy.inventory.update',
          method: 'PUT',
          // Carexy accepts extra fields; our write type is the confirmed subset.
          path: CAREXY_PATHS.inventoryUpdate(inventory.inventoryUuid),
          body,
          authHeaders: this.auth(account),
        });
        succeeded += 1;
      } catch (error) {
        const failure = this.toFailure(item.externalVariantId, error);
        failures.push(failure);
        if (failure.code === 'UNAUTHENTICATED') break;
      }
    }
    return { ok: failures.length === 0, succeeded, failed: failures };
  }

  async pushPrices(account: AdapterAccount, items: readonly PriceUpdate[]): Promise<BatchResult> {
    const failures: BatchItemFailure[] = [];
    let succeeded = 0;
    for (const item of items) {
      try {
        const mapped = await this.deps.mappings.findProductMappingByExternal(
          account.id,
          item.externalVariantId,
        );
        if (mapped?.externalProductId === null || mapped?.externalProductId === undefined) {
          throw new IntegrationError('MAPPING_REQUIRED', {
            messageFa: 'برای این تنوع، نگاشت محصول در کرکسی وجود ندارد.',
            details: { externalVariantId: item.externalVariantId },
          });
        }
        const inventories = await this.listInventories(account, mapped.externalProductId);
        // Carexy does not expose an inventory id in the product mapping; a
        // single-inventory product is unambiguous, otherwise the operator must
        // supply the inventory mapping before a price push is allowed.
        const target = inventories.length === 1 ? inventories[0] : undefined;
        if (target === undefined) {
          throw new IntegrationError('MAPPING_REQUIRED', {
            messageFa: 'موجودی متناظر در کرکسی یکتا نیست؛ نگاشت موجودی لازم است.',
          });
        }
        await this.deps.http.request(account, {
          operation: 'carexy.price.update',
          method: 'PUT',
          path: CAREXY_PATHS.inventoryUpdate(target.inventoryUuid),
          body: {
            user_id: this.userId(account),
            count: target.available,
            price: item.value.price,
            ...(item.value.discountPrice === undefined
              ? {}
              : { discount_price: item.value.discountPrice }),
            ...(item.value.discountExpire === undefined
              ? {}
              : { discount_expire: item.value.discountExpire.toISOString() }),
          },
          authHeaders: this.auth(account),
        });
        succeeded += 1;
      } catch (error) {
        failures.push(this.toFailure(item.externalVariantId, error));
      }
    }
    return { ok: failures.length === 0, succeeded, failed: failures };
  }

  /** Reconciliation-only read: product-level inventories, single-match only. */
  async *pullInventory(
    account: AdapterAccount,
    refs: readonly { variantId: string; externalVariantId: string; externalProductId?: string }[],
  ): AsyncIterable<{ variantId: string; available: string }> {
    const byProduct = new Map<string, string[]>();
    for (const ref of refs) {
      if (ref.externalProductId === undefined) continue;
      const list = byProduct.get(ref.externalProductId) ?? [];
      list.push(ref.variantId);
      byProduct.set(ref.externalProductId, list);
    }
    for (const [productUuid, variantIds] of byProduct) {
      const inventories = await this.listInventories(account, productUuid);
      const single = inventories.length === 1 ? inventories[0] : undefined;
      if (single === undefined) continue;
      for (const variantId of variantIds) {
        yield { variantId, available: single.available };
      }
    }
  }

  /**
   * First-sync catalogue import. Reads `GET /api/v1/products` page by page and
   * maps only fields the contract exposes, tolerating Carexy's
   * `{success, response: {data: [...]}, code}` envelope and the common Laravel
   * shapes (`{data: [...]}`, `{data: {data: [...]}}`).
   */
  async *pullProducts(account: AdapterAccount): AsyncIterable<ExternalProduct> {
    const perPage = 50;
    const maxPages = 20;
    // List rows without stock cost one extra request each; bound that blast radius.
    const maxInventoryLookups = 50;
    let inventoryLookups = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.deps.http.request(account, {
        operation: 'carexy.products.list',
        method: 'GET',
        path: CAREXY_PATHS.products,
        query: { per_page: perPage, page },
        authHeaders: this.auth(account),
        idempotent: true,
      });
      const items = listPayload(response.json);
      // Diagnostics: Carexy's list shape varies between deployments; log the envelope shape once per page.
      logListEnvelope(page, response.json, items);
      const failure = providerFailure(response.json);
      if (failure !== null) {
        throw new IntegrationError(
          failure.httpStatus === 401
            ? 'UNAUTHENTICATED'
            : failure.httpStatus === 403
              ? 'FORBIDDEN'
              : 'UPSTREAM_INVALID_RESPONSE',
          {
            messageFa: `کرکسی فهرست محصولات را رد کرد (کد ${failure.code}).`,
            retryable: false,
            ...(failure.httpStatus > 0 ? { httpStatus: failure.httpStatus } : {}),
            details: { providerCode: failure.code },
          },
        );
      }
      for (const raw of items) {
        if (!isRecord(raw)) continue;
        const externalProductId = scalar(pick(raw, ['uuid', 'product_uuid', 'id', 'product_id']));
        if (externalProductId === undefined) continue;

        const inline = ['inventories', 'inventory', 'stocks'].flatMap((key) => {
          const value = raw[key];
          if (Array.isArray(value)) return value as unknown[];
          return isRecord(value) ? [value] : [];
        });
        const firstInventory = inline.find(isRecord);

        let externalVariantId =
          (firstInventory === undefined
            ? undefined
            : scalar(firstInventory['inventory_uuid'])) ?? scalar(raw['variant_uuid']);
        const sku =
          scalar(pick(raw, ['sku', 'product_code', 'code'])) ??
          (firstInventory === undefined
            ? undefined
            : scalar(pick(firstInventory, ['sku', 'code'])));
        const barcode =
          scalar(pick(raw, ['barcode'])) ??
          (firstInventory === undefined ? undefined : scalar(pick(firstInventory, ['barcode'])));
        const price =
          numeric(pick(raw, ['price', 'sale_price', 'final_price'])) ??
          (firstInventory === undefined
            ? undefined
            : numeric(pick(firstInventory, ['price', 'sale_price', 'final_price'])));
        let available = sumStock(inline) ?? numeric(pick(raw, ['stock', 'quantity', 'available']));

        if (available === undefined && inventoryLookups < maxInventoryLookups) {
          inventoryLookups += 1;
          try {
            const inventories = await this.listInventories(account, externalProductId);
            available = sumStock(
              inventories.map((inventory) => ({ count: inventory.available })),
            );
            externalVariantId ??= inventories[0]?.inventoryUuid;
          } catch (error) {
            this.deps.logger.warn(
              {
                externalProductId,
                error: error instanceof Error ? error.message : 'inventory_lookup_failed',
              },
              'carexy inventory lookup failed during product pull',
            );
          }
        }

        const title =
          scalar(pick(raw, ['title', 'name', 'name_fa', 'product_name'])) ?? externalProductId;

        // Detail copy/specs: only fields the list payload actually exposes.
        const description = scalar(
          pick(raw, ['description', 'content', 'body', 'long_description', 'short_description']),
        );
        const brandValue = pick(raw, ['brand', 'brand_name', 'brand_title']);
        const brand =
          scalar(brandValue) ??
          (isRecord(brandValue) ? scalar(pick(brandValue, ['name', 'title'])) : undefined);
        const categoryValue = pick(raw, ['category', 'category_name', 'categoryName', 'group']);
        const categoryName =
          scalar(categoryValue) ??
          (isRecord(categoryValue) ? scalar(pick(categoryValue, ['name', 'title'])) : undefined);
        const attributes = collectAttributes(raw);

        yield {
          externalProductId,
          ...(externalVariantId === undefined ? {} : { externalVariantId }),
          title,
          ...(sku === undefined ? {} : { sku }),
          ...(barcode === undefined ? {} : { barcode }),
          ...(price === undefined ? {} : { price }),
          ...(available === undefined ? {} : { available }),
          ...(description === undefined ? {} : { description }),
          ...(brand === undefined ? {} : { brand }),
          ...(categoryName === undefined ? {} : { categoryName }),
          ...(attributes === undefined ? {} : { attributes }),
          raw,
        };
      }
      if (items.length < perPage) break;
    }
  }

  async *pullOrders(): AsyncIterable<CanonicalOrder> {
    throw new IntegrationError('NOT_IMPLEMENTED', {
      messageFa: 'دریافت سفارش از کرکسی تا تأیید قرارداد پشتیبانی نمی‌شود.',
      details: { feature: CAREXY_TBD.orders },
    });
  }

  async acknowledgeOrder(): Promise<void> {
    throw new IntegrationError('NOT_IMPLEMENTED', {
      messageFa: 'تأیید سفارش در کرکسی قرارداد تأییدشده ندارد.',
      details: { feature: CAREXY_TBD.ack },
    });
  }

  async updateShipment(): Promise<void> {
    throw new IntegrationError('NOT_IMPLEMENTED', {
      messageFa: 'به‌روزرسانی مرسوله در کرکسی قرارداد تأییدشده ندارد.',
      details: { feature: CAREXY_TBD.shipment },
    });
  }

  verifyWebhook(input: WebhookVerifyInput): WebhookVerdict {
    return verifyWebhook(input, { config: WEBHOOK_SIGNATURE_CONFIG.carexy });
  }

  /** Full-reconcile helper: authoritative external stock for a product. */
  async listInventories(
    account: AdapterAccount,
    productUuid: string,
    options: { readonly fresh?: boolean } = {},
  ): Promise<readonly CarexyInventorySnapshot[]> {
    const key = `${account.id}:${productUuid}`;
    const cached = this.inventoryCache.get(key);
    if (options.fresh !== true && cached !== undefined && cached.expiresAt > this.now()) {
      return cached.items;
    }
    const response: PartnerResponse = await this.deps.http.request(account, {
      operation: 'carexy.inventory.list',
      method: 'GET',
      path: CAREXY_PATHS.inventoriesOfProduct(productUuid),
      authHeaders: this.auth(account),
      idempotent: true,
    });
    const items = listPayload(response.json)
      .filter((item): item is CarexyInventoryResponse => typeof item === 'object' && item !== null)
      .map(mapCarexyInventory)
      .filter((inventory) => inventory.inventoryUuid.length > 0);
    // An empty page is cached for much less time: an operator who adds the
    // inventory in the panel should not wait ten minutes for the next push.
    const ttlMs = items.length === 0 ? 120_000 : 600_000;
    this.inventoryCache.set(key, { expiresAt: this.now() + ttlMs, items });
    if (this.inventoryCache.size > 2_000) this.inventoryCache.clear();
    return items;
  }

  async listStorages(
    account: AdapterAccount,
  ): Promise<readonly { storageUuid: string; name: string }[]> {
    const response = await this.deps.http.request(account, {
      operation: 'carexy.storage.list',
      method: 'GET',
      path: CAREXY_PATHS.storages,
      authHeaders: this.auth(account),
    });
    return listPayload(response.json)
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        storageUuid: String(item['storage_uuid'] ?? ''),
        name: String(item['name'] ?? ''),
      }))
      .filter((storage) => storage.storageUuid.length > 0);
  }

  private async resolveInventory(
    account: AdapterAccount,
    item: InventoryUpdate,
  ): Promise<{ inventoryUuid: string }> {
    if (item.externalInventoryId !== undefined && item.externalInventoryId.length > 0) {
      return { inventoryUuid: item.externalInventoryId };
    }
    if (item.externalProductId === undefined || item.externalProductId.length === 0) {
      throw new IntegrationError('MAPPING_REQUIRED', {
        messageFa: 'برای ارسال موجودی، ابتدا محصول را در کرکسی نگاشت کنید.',
        details: { externalVariantId: item.externalVariantId },
      });
    }
    const inventories = await this.listInventories(account, item.externalProductId);
    const desiredVariables = item.variables ?? {};
    const matched = inventories.find((inventory) =>
      Object.entries(desiredVariables).every(
        ([key, value]) => inventory.variables[key] === value,
      ),
    );
    // Prefer the inventory id recorded on the product mapping, then variable
    // matching, then the single inventory. Older imports stored the product id
    // in external_variant_id, so a multi-inventory product could never match;
    // fall back to the first inventory (deterministic) and log the guess so the
    // operator can fix the mapping later instead of blocking every push.
    const byId = inventories.find((inventory) => inventory.inventoryUuid === item.externalVariantId);
    let target = byId ?? matched ?? (inventories.length === 1 ? inventories[0] : undefined);
    if (target === undefined && inventories.length > 1) {
      target = inventories[0];
      this.deps.logger.warn(
        { externalProductId: item.externalProductId, externalVariantId: item.externalVariantId, candidates: inventories.length },
        'carexy inventory mapping ambiguous; using first inventory',
      );
    }
    if (target === undefined) {
      throw new IntegrationError('MAPPING_REQUIRED', {
        messageFa: 'موجودی متناظر با تنوع محصول در کرکسی یافت نشد.',
        details: { externalVariantId: item.externalVariantId },
      });
    }
    return { inventoryUuid: target.inventoryUuid };
  }

  private toFailure(externalId: string, error: unknown): BatchItemFailure {
    if (error instanceof IntegrationError) {
      this.deps.logger.warn(
        { accountExternalId: externalId, code: error.code },
        'carexy item failed',
      );
      return {
        externalId,
        code: error.code,
        messageFa: error.messageFa,
        retryable: error.retryable,
      };
    }
    this.deps.logger.error(
      { externalId, error: error instanceof Error ? error.message : 'unknown' },
      'carexy item failed unexpectedly',
    );
    return {
      externalId,
      code: 'UPSTREAM_UNAVAILABLE',
      messageFa: 'ارتباط با کرکسی برقرار نشد.',
      retryable: true,
    };
  }
}
