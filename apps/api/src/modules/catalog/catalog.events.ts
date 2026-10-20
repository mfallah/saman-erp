/**
 * Catalog domain events (`ARCHITECTURE.md` §7, outbox).
 *
 * Event names are stable and versioned by the shared `outbox_events.event_type`
 * vocabulary. Payloads carry public UUIDs and money as integer strings
 * (`ADR-0013`) so consumers never depend on internal bigint ids.
 */
export const CATALOG_EVENTS = {
  categoryCreated: 'catalog.category.created',
  categoryUpdated: 'catalog.category.updated',
  categoryMoved: 'catalog.category.moved',
  categoryDeleted: 'catalog.category.deleted',
  brandCreated: 'catalog.brand.created',
  brandUpdated: 'catalog.brand.updated',
  brandDeleted: 'catalog.brand.deleted',
  productCreated: 'catalog.product.created',
  productUpdated: 'catalog.product.updated',
  productPublished: 'catalog.product.published',
  productArchived: 'catalog.product.archived',
  productDeleted: 'catalog.product.deleted',
  variantCreated: 'catalog.variant.created',
  variantUpdated: 'catalog.variant.updated',
  variantDeleted: 'catalog.variant.deleted',
  barcodeAdded: 'catalog.barcode.added',
  barcodeRemoved: 'catalog.barcode.removed',
  mediaAttached: 'catalog.media.attached',
  mediaRemoved: 'catalog.media.removed',
  unitCreated: 'catalog.unit.created',
  unitConversionAdded: 'catalog.unit.conversion_added',
  priceChanged: 'catalog.price.changed',
  costChanged: 'catalog.cost.changed',
} as const;

export type CatalogEventType = (typeof CATALOG_EVENTS)[keyof typeof CATALOG_EVENTS];

export interface ProductEventPayload {
  readonly productId: string;
  readonly productNo: string;
  readonly status: string;
  readonly changedFields: readonly string[];
}

export interface VariantEventPayload {
  readonly productId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly changedFields: readonly string[];
}

export interface BarcodeEventPayload {
  readonly variantId: string;
  readonly barcodeId: string;
  readonly barcode: string;
  readonly barcodeType: string;
}

export interface CategoryEventPayload {
  readonly categoryId: string;
  readonly code: string;
  readonly parentId: string | null;
  readonly path: string;
}

export interface PriceChangedPayload {
  readonly variantId: string;
  /** Integer IRR string (`ADR-0013`). */
  readonly priceAmount: string;
  readonly previousPriceAmount: string | null;
  readonly effectiveFrom: string;
  readonly sourceType: 'manual' | 'pricing_run' | 'channel' | 'import';
}

export interface CostChangedPayload {
  readonly variantId: string;
  /** Integer IRR string (`ADR-0013`). */
  readonly costAmount: string;
  readonly avgCostAmount: string;
  readonly costMethod: 'moving_average' | 'fifo' | 'standard';
  readonly sourceType: 'receipt' | 'valuation' | 'manual' | 'import';
}
