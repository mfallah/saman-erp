/**
 * Adapter port (ADR-0006). Adapters depend on this port and on infrastructure
 * utilities; the core never depends on a partner implementation.
 */
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
} from '../domain/channel.types';

export interface ExternalVariantRef {
  readonly variantId: string;
  readonly externalVariantId: string;
  readonly externalProductId?: string;
}

/** A product as read from a channel during first-sync import. */
export interface ExternalProduct {
  readonly externalProductId: string;
  readonly externalVariantId?: string;
  readonly title: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly price?: string;
  readonly available?: string;
  /** Long copy from the channel; persisted on `erp.products.description`. */
  readonly description?: string;
  /** Free-text brand name; not resolved into `erp.brands` on import. */
  readonly brand?: string;
  /** Category display name; find-or-created per organization on import. */
  readonly categoryName?: string;
  /** Scalar specification pairs from the channel; persisted as `attributes_json`. */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly raw?: unknown;
}

export interface ChannelAdapter {  readonly code: ChannelCode;
  readonly capabilities: ReadonlySet<Capability>;
  /** Code-declared hosts only (production/sandbox), asserted at boot. */
  readonly declaredHosts: readonly string[];

  /** Selects a code-declared base URL; `settings.baseUrl` is never trusted. */
  baseUrlFor(sandbox: boolean): string;

  authenticate(account: AdapterAccount): Promise<AuthResult>;
  healthCheck(account: AdapterAccount): Promise<AuthResult>;

  pushInventory(account: AdapterAccount, items: readonly InventoryUpdate[]): Promise<BatchResult>;
  pushPrices(account: AdapterAccount, items: readonly PriceUpdate[]): Promise<BatchResult>;

  pullOrders(
    account: AdapterAccount,
    since: Date,
    cursor?: string,
  ): AsyncIterable<CanonicalOrder>;

  acknowledgeOrder(account: AdapterAccount, externalOrderId: string, status: string): Promise<void>;
  updateShipment(account: AdapterAccount, update: ShipmentUpdate): Promise<void>;

  pullSettlements?(account: AdapterAccount, since: Date): AsyncIterable<SettlementSummary>;

  /** First-sync catalogue read used to seed products, variants and mappings. */
  pullProducts?(account: AdapterAccount): AsyncIterable<ExternalProduct>;

  /** Reconciliation-only stock read; never used as a write source of truth. */
  pullInventory?(
    account: AdapterAccount,
    refs: readonly ExternalVariantRef[],
  ): AsyncIterable<{ readonly variantId: string; readonly available: string }>;

  verifyWebhook(input: WebhookVerifyInput): WebhookVerdict;

  supports(capability: Capability): boolean;
}

export const CHANNEL_ADAPTERS = Symbol.for('saman.channel-adapters');
