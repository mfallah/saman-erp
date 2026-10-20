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
import type { ChannelAdapter } from '../../ports/channel-adapter.port';
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

function listPayload(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (typeof json === 'object' && json !== null) {
    const body = json as Record<string, unknown>;
    for (const key of ['data', 'items', 'result', 'inventories', 'products']) {
      const value = body[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

export class CarexyAdapter implements ChannelAdapter {
  readonly code: ChannelCode = 'carexy';
  readonly capabilities: ReadonlySet<Capability> = new Set(CAREXY_CAPABILITIES);
  readonly declaredHosts = CAREXY_HOSTS;

  constructor(
    private readonly deps: {
      readonly http: PartnerHttpClient;
      readonly mappings: ChannelMappingRepositoryPort;
      readonly logger: AppLogger;
    },
  ) {}

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
  ): Promise<readonly CarexyInventorySnapshot[]> {
    const response: PartnerResponse = await this.deps.http.request(account, {
      operation: 'carexy.inventory.list',
      method: 'GET',
      path: CAREXY_PATHS.inventoriesOfProduct(productUuid),
      authHeaders: this.auth(account),
    });
    return listPayload(response.json)
      .filter((item): item is CarexyInventoryResponse => typeof item === 'object' && item !== null)
      .map(mapCarexyInventory)
      .filter((inventory) => inventory.inventoryUuid.length > 0);
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
    const target = matched ?? (inventories.length === 1 ? inventories[0] : undefined);
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
