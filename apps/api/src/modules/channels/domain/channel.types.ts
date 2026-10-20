/**
 * Canonical channel vocabulary (ADR-0006).
 *
 * Partner payloads never cross this boundary: adapters translate into these
 * types and the ERP persists only canonical orders/stock/prices plus mappings.
 * Money is an integer-IRR decimal string (`ADR-0013`), quantities are decimal
 * strings (`numeric(18,4)`).
 */

export const CHANNEL_CODES = ['carexy', 'digikala', 'mock'] as const;
export type ChannelCode = (typeof CHANNEL_CODES)[number];

export const CAPABILITIES = [
  'stock.push',
  'price.push',
  'order.pull',
  'order.ack',
  'shipment.update',
  'label.print',
  'product.push',
  'settlement.pull',
  'webhook.verify',
  'health.check',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type IntegrationErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_INVALID_RESPONSE'
  | 'NOT_IMPLEMENTED'
  | 'MAPPING_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'BUDGET_EXHAUSTED';

/** Thrown by adapters/clients; carries a Persian, user-safe message only. */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly messageFa: string;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code: IntegrationErrorCode,
    options: {
      messageFa: string;
      retryable?: boolean;
      httpStatus?: number;
      details?: Readonly<Record<string, string>>;
      cause?: unknown;
    },
  ) {
    super(options.messageFa, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IntegrationError';
    this.code = code;
    this.messageFa = options.messageFa;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
    this.details = options.details;
  }
}

function defaultHttpStatus(code: IntegrationErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'NOT_IMPLEMENTED':
      return 501;
    case 'VALIDATION_ERROR':
    case 'MAPPING_REQUIRED':
    case 'BUDGET_EXHAUSTED':
      return 422;
    default:
      return 502;
  }
}

/** A channel account with its secrets already decrypted *in adapter call scope only*. */
export interface AdapterAccount {
  readonly id: string;
  readonly publicId: string;
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  readonly organizationId: string;
  /** Host selected from the adapter's code-declared set (never free-form). */
  readonly baseUrl: string;
  readonly sandbox: boolean;
  readonly rateLimitPerMin: number;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Secrets by key name. Must never be logged or included in errors. */
  readonly credentials: Readonly<Record<string, string>>;
}

export interface AuthResult {
  readonly ok: boolean;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
  readonly latencyMs: number;
}

export interface InventoryUpdate {
  readonly externalProductId?: string;
  readonly externalVariantId: string;
  readonly externalInventoryId?: string;
  readonly externalStorageId?: string;
  /** Always ERP *available* quantity, never `on_hand` (ADR-0007 §4). */
  readonly available: string;
  readonly price?: PriceValue;
  readonly weight?: string;
  readonly variables?: Readonly<Record<string, string>>;
}

export interface PriceValue {
  /** Integer IRR string. */
  readonly price: string;
  readonly discountPrice?: string;
  readonly discountExpire?: Date;
  /** Tiered quantity discounts; unmapped by default (TBD field). */
  readonly discountTree?: Readonly<Record<string, string>>;
}

export interface PriceUpdate {
  readonly externalVariantId: string;
  readonly value: PriceValue;
}

export interface BatchItemFailure {
  readonly externalId: string;
  readonly code: IntegrationErrorCode;
  readonly messageFa: string;
  readonly retryable: boolean;
}

export interface BatchResult {
  readonly ok: boolean;
  readonly succeeded: number;
  readonly failed: readonly BatchItemFailure[];
}

export interface CanonicalOrderLine {
  readonly externalLineId: string;
  readonly externalSku: string;
  readonly externalVariantId?: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
}

export interface CanonicalOrder {
  readonly externalOrderId: string;
  readonly externalStatus: string;
  readonly placedAt: Date;
  readonly currency: 'IRR';
  readonly lines: readonly CanonicalOrderLine[];
  readonly totals: {
    readonly itemsTotal: string;
    readonly shipping: string;
    readonly discount: string;
    readonly grandTotal: string;
  };
  /** Stable hash of the partner customer id: no PII in canonical events/logs. */
  readonly customerRefHash: string;
  /** Stable hash of the delivery address: full details are fetched on demand. */
  readonly shippingRefHash: string;
  /** SHA-256 of the raw partner payload; the payload itself is never stored. */
  readonly rawPayloadHash: string;
}

export interface ShipmentUpdate {
  readonly externalOrderId: string;
  readonly externalShipmentId?: string;
  readonly trackingCode?: string;
  readonly status: 'dispatched' | 'delivered' | 'returned' | 'cancelled';
  readonly occurredAt: Date;
}

export interface SettlementSummary {
  readonly externalId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly grossAmount: string;
  readonly commissionAmount: string;
  readonly netAmount: string;
}

export interface WebhookVerifyInput {
  readonly channelId: string;
  readonly accountId: string;
  /** Raw bytes exactly as received; never re-serialized JSON. */
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly secrets: readonly string[];
  readonly now?: Date;
}

export type WebhookRejectionReason =
  | 'signature_missing'
  | 'signature_invalid'
  | 'timestamp_missing'
  | 'timestamp_invalid'
  | 'timestamp_skew'
  | 'event_id_missing'
  | 'secret_not_configured'
  | 'body_unavailable';

export type WebhookVerdict =
  | {
      readonly valid: true;
      readonly eventId: string;
      readonly timestamp: Date;
      readonly headerName: string;
    }
  | {
      readonly valid: false;
      readonly reason: WebhookRejectionReason;
      readonly eventId?: string;
    };
