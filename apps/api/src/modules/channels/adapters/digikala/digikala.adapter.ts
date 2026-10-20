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
import { verifyWebhook, WEBHOOK_SIGNATURE_CONFIG } from '../../domain/webhook-signature';
import type { ChannelAdapter } from '../../ports/channel-adapter.port';
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

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
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
    const clientId = account.credentials['client_id'];
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
      return this.readToken(response, null);
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
        body: { refresh_token: current.refreshToken },
        authHeaders: {},
        maxAttempts: 1,
      });
      const token = this.readToken(response, current.refreshToken);
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

  private readToken(response: PartnerResponse, previousRefresh: string | null): DigikalaTokenSet {
    const body = record(response.json);
    const accessToken = stringValue(body['access_token']);
    const expiresIn = Number(body['expires_in'] ?? 3600);
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

  async authenticate(account: AdapterAccount): Promise<AuthResult> {
    const started = Date.now();
    await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.profile',
        method: 'GET',
        path: DIGIKALA_PATHS.profile,
        authHeaders,
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
    let succeeded = 0;
    const bulk = items.length > 1 && this.tbdEnabled();
    if (bulk) {
      try {
        await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: 'digikala.stock.bulk',
            method: 'POST',
            path: DIGIKALA_PATHS.bulkSellerStock,
            authHeaders,
            // TBD-DIGIKALA: batch envelope unconfirmed.
            body: {
              items: items.map((item) => ({
                variant_id: item.externalVariantId,
                stock: item.available,
              })),
            },
          }),
        );
        return { ok: true, succeeded: items.length, failed: [] };
      } catch (error) {
        this.deps.logger.warn(
          { accountId: account.id, error: error instanceof Error ? error.message : 'bulk_failed' },
          'digikala bulk stock failed; falling back to single updates',
        );
      }
    }
    for (const item of items) {
      try {
        await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: 'digikala.stock.update',
            method: 'PATCH',
            path: DIGIKALA_PATHS.sellerStock(item.externalVariantId),
            authHeaders,
            body: { stock: item.available },
            idempotent: true,
          }),
        );
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
    this.requireTbd(TBD_DIGIKALA.pricePushPayload);
    const failures: BatchItemFailure[] = [];
    let succeeded = 0;
    for (const item of items) {
      try {
        await this.withAuth(account, (authHeaders) =>
          this.deps.http.request(account, {
            operation: 'digikala.price.update',
            method: 'PATCH',
            path: DIGIKALA_PATHS.sellingPrice,
            authHeaders,
            body: { variant_id: item.externalVariantId, price: item.value.price },
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
    this.requireTbd(TBD_DIGIKALA.orderResponse);
    const response = await this.withAuth(account, (authHeaders) =>
      this.deps.http.request(account, {
        operation: 'digikala.orders.pull',
        method: 'GET',
        path: DIGIKALA_PATHS.sbsOrders,
        // TBD-DIGIKALA: filter names are not in the supplied schema.
        query: { from: since.toISOString(), page: 1 },
        authHeaders,
      }),
    );
    for (const raw of arrayPayload(response.json)) {
      yield this.mapOrder(raw);
    }
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
      placedAt: new Date(stringValue(body['created_at']) ?? Date.now()),
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
