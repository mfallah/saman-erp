/**
 * Carexy inventory payloads (§8.2, §53–54).
 *
 * `count` is the ERP **available** quantity. `price`/`discount_price` map from
 * the published channel price snapshot. `purchase_price` is a channel field
 * that is **never sent** (cost stays in the ERP). `sale_min`, `max_sale`,
 * `original`, `used`, `time_send`, `weight` are channel attributes we read but
 * never persist on core tables.
 */
export interface CarexyInventoryResponse {
  readonly inventory_uuid?: string;
  readonly product_uuid?: string;
  readonly storage_uuid?: string;
  readonly variables?: Record<string, unknown>;
  readonly price?: string | number;
  readonly discount_price?: string | number | null;
  readonly discount_expire?: string | null;
  readonly discount_tree?: unknown;
  readonly count?: string | number;
  readonly sale_min?: string | number;
  readonly max_sale?: string | number;
  readonly original?: string | number;
  readonly used?: string | number;
  readonly weight?: string | number;
  readonly purchase_price?: string | number;
  readonly time_send?: string | number;
}

export interface CarexyStorageResponse {
  readonly storage_uuid?: string;
  readonly name?: string;
}

export interface CarexyInventorySnapshot {
  readonly inventoryUuid: string;
  readonly productUuid: string | null;
  readonly storageUuid: string | null;
  readonly variables: Record<string, string>;
  readonly price: string;
  readonly discountPrice: string | null;
  readonly discountExpire: Date | null;
  readonly available: string;
  /** Channel-only attributes; never written to core tables. */
  readonly channelAttributes: {
    readonly saleMin: string | null;
    readonly maxSale: string | null;
    readonly weight: string | null;
    readonly timeSend: string | null;
  };
}

export interface CarexyInventoryWrite {
  readonly user_id: string;
  readonly storage_uuid?: string;
  readonly variables?: Record<string, string>;
  readonly count: string;
  readonly price?: string;
  readonly discount_price?: string;
  readonly discount_expire?: string;
  readonly weight?: string;
}

function decimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

export function mapCarexyInventory(raw: CarexyInventoryResponse): CarexyInventorySnapshot {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.variables ?? {})) {
    variables[key] = String(value);
  }
  const price = decimal(raw.price) ?? '0';
  const discountExpire =
    typeof raw.discount_expire === 'string' ? new Date(raw.discount_expire) : null;
  return {
    inventoryUuid: String(raw.inventory_uuid ?? ''),
    productUuid: raw.product_uuid === undefined ? null : String(raw.product_uuid),
    storageUuid: raw.storage_uuid === undefined ? null : String(raw.storage_uuid),
    variables,
    price,
    discountPrice: decimal(raw.discount_price),
    discountExpire:
      discountExpire !== null && !Number.isNaN(discountExpire.getTime()) ? discountExpire : null,
    available: decimal(raw.count) ?? '0',
    channelAttributes: {
      saleMin: decimal(raw.sale_min),
      maxSale: decimal(raw.max_sale),
      weight: decimal(raw.weight),
      timeSend: decimal(raw.time_send),
    },
  };
}

export function toCarexyInventoryWrite(input: {
  userId: string;
  available: string;
  storageUuid?: string;
  variables?: Readonly<Record<string, string>>;
  price?: string;
  discountPrice?: string;
  discountExpire?: Date;
  weight?: string;
}): CarexyInventoryWrite {
  return {
    user_id: input.userId,
    ...(input.storageUuid === undefined ? {} : { storage_uuid: input.storageUuid }),
    ...(input.variables === undefined ? {} : { variables: { ...input.variables } }),
    count: input.available,
    ...(input.price === undefined ? {} : { price: input.price }),
    ...(input.discountPrice === undefined ? {} : { discount_price: input.discountPrice }),
    ...(input.discountExpire === undefined
      ? {}
      : { discount_expire: input.discountExpire.toISOString() }),
    ...(input.weight === undefined ? {} : { weight: input.weight }),
  };
}
