/**
 * Deterministic mock adapter (`mock` channel) for development, CI and
 * integration tests. No network, stable ids and payload hashes.
 */
import { createHash } from 'node:crypto';

import type {
  AdapterAccount,
  AuthResult,
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
import { verifyWebhook, WEBHOOK_SIGNATURE_CONFIG } from '../../domain/webhook-signature';
import type { ChannelAdapter } from '../../ports/channel-adapter.port';
import { hashPii } from '../../domain/pii';

const MOCK_BASE_URL = 'https://mock.saman-erp.local';
const MOCK_ORDER_INTERVAL_MS = 15 * 60 * 1000;

export class MockAdapter implements ChannelAdapter {
  readonly code: ChannelCode = 'mock';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'stock.push',
    'price.push',
    'order.pull',
    'order.ack',
    'shipment.update',
    'settlement.pull',
    'webhook.verify',
    'health.check',
  ]);
  // Mock never uses the network, but declares its host for completeness.
  readonly declaredHosts = ['mock.saman-erp.local'];

  baseUrlFor(): string {
    return MOCK_BASE_URL;
  }

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  async authenticate(account: AdapterAccount): Promise<AuthResult> {
    void account;
    return { ok: true, scopes: ['mock'], latencyMs: 1 };
  }

  async healthCheck(account: AdapterAccount): Promise<AuthResult> {
    return this.authenticate(account);
  }

  async pushInventory(
    account: AdapterAccount,
    items: readonly InventoryUpdate[],
  ): Promise<BatchResult> {
    void account;
    return { ok: true, succeeded: items.length, failed: [] };
  }

  async pushPrices(account: AdapterAccount, items: readonly PriceUpdate[]): Promise<BatchResult> {
    void account;
    return { ok: true, succeeded: items.length, failed: [] };
  }

  async *pullOrders(account: AdapterAccount, since: Date): AsyncIterable<CanonicalOrder> {
    const start = Math.floor(since.getTime() / MOCK_ORDER_INTERVAL_MS) * MOCK_ORDER_INTERVAL_MS;
    for (let index = 0; index < 3; index += 1) {
      const placedAt = new Date(start + index * MOCK_ORDER_INTERVAL_MS);
      const externalOrderId = `MOCK-${account.id}-${placedAt.toISOString()}`;
      const raw = JSON.stringify({ id: externalOrderId, index });
      yield {
        externalOrderId,
        externalStatus: 'pending',
        placedAt,
        currency: 'IRR',
        lines: [
          {
            externalLineId: `${externalOrderId}-1`,
            externalSku: `MOCK-SKU-${index + 1}`,
            quantity: '1.0000',
            unitPrice: String(1_000_000 + index * 100_000),
            discount: '0',
          },
        ],
        totals: {
          itemsTotal: String(1_000_000 + index * 100_000),
          shipping: '0',
          discount: '0',
          grandTotal: String(1_000_000 + index * 100_000),
        },
        customerRefHash: hashPii(`mock-customer-${index}`),
        shippingRefHash: hashPii(`mock-address-${index}`),
        rawPayloadHash: createHash('sha256').update(raw).digest('hex'),
      };
    }
  }

  async acknowledgeOrder(): Promise<void> {}
  async updateShipment(): Promise<void> {}

  async *pullInventory(): AsyncIterable<{ variantId: string; available: string }> {
    // Deterministic zero drift: mock has no external stock of its own.
  }

  async *pullSettlements(): AsyncIterable<SettlementSummary> {
    // none by default
  }

  verifyWebhook(input: WebhookVerifyInput): WebhookVerdict {
    return verifyWebhook(input, { config: WEBHOOK_SIGNATURE_CONFIG.mock });
  }
}
