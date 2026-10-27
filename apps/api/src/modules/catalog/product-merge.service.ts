/**
 * Product merge workbench (`API.md` catalog section).
 *
 * Duplicate detection, single/batch merge, undo and the xlsx import/export all
 * live here so the controller stays a thin transport layer.
 *
 * Merge semantics (unchanged from the original manual merge):
 * - same-SKU source variant → non-conflicting channel mappings are re-pointed to
 *   the target variant, conflicting ones are retired, the duplicate variant is
 *   soft-deleted;
 * - unmatched variant → `product_id` moves to the target;
 * - only-empty target master fields are filled; the source product is archived.
 *
 * Inventory is never rewritten here. `inventory_balances` / `inventory_transactions`
 * stay bound to the variant rows that own them. When a duplicate variant carried
 * stock and its SKU folded into the target variant, the operator gets an explicit
 * warning (moving stock is only safe through the inventory adjustment ledger API,
 * which this module deliberately does not call).
 *
 * Every merge writes `erp.product_merge_log` with a snapshot complete enough to
 * undo it. If that table is not present yet (migration owned elsewhere) the merge
 * still succeeds and reports `mergeLogRecorded: false`.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '@saman/shared';

import { DB, type TenantContext } from '../../common/contracts';
import { ChannelSyncService } from '../channels/services/channel-sync.service';
import { notFound, toIsoRequired, type Db } from './pg-support';
import { buildXlsx, readXlsxRows } from './merge-xlsx';

/** Channel codes treated as import sources by the suggestions engine. */
const IMPORT_SOURCES = new Set<string>(['carexy', 'digikala']);

function isImportSource(source: string): boolean {
  return IMPORT_SOURCES.has(source);
}
const MIN_SIMILARITY = 0.55;
const DEFAULT_SUGGESTION_LIMIT = 50;
const MAX_SUGGESTION_LIMIT = 200;
const MAX_PRODUCTS_SCANNED = 2500;
const MAX_EXPORT_ROWS = 2000;

/** `source` per product: the channel code of its first active listing. */
const SOURCES_CTE = `
  sources as (
    select v.product_id as product_id, min(ch.code) as source
    from erp.product_variants v
    join erp.channel_product_mappings m
      on m.product_variant_id = v.id and m.deleted_at is null
    join erp.channel_accounts a
      on a.id = m.channel_account_id and a.deleted_at is null
    join erp.sales_channels ch on ch.id = a.channel_id
    where v.deleted_at is null
    group by v.product_id
  )`;

const SKUS_SUBQUERY = `(
  select string_agg(v.sku, chr(1) order by v.id)
  from erp.product_variants v
  where v.product_id = p.id and v.deleted_at is null
)`;

const NORMALIZED_NAME = `lower(regexp_replace(
  coalesce(p.name, '') || ' ' || coalesce(p.name_en, ''),
  '[^0-9A-Za-zآ-ی۰-۹]+', ' ', 'g'
))`;

export type SimilarityMethod = 'pg_trgm' | 'normalized_bigram_dice';

export interface MergePairInput {
  readonly targetProductId: string;
  readonly sourceProductId: string;
}

export interface SuggestionPair {
  readonly aId: string;
  readonly aName: string;
  readonly aSource: string;
  readonly aProductNo: string;
  readonly bId: string;
  readonly bName: string;
  readonly bSource: string;
  readonly bProductNo: string;
  readonly similarity: number;
  readonly sameSku: boolean;
}

export interface MergeWarning {
  readonly code: string;
  readonly messageFa: string;
  readonly variantId?: string;
  readonly sku?: string;
}

export interface ChannelPushSummary {
  readonly accounts: readonly string[];
  readonly triggered: readonly string[];
  readonly failed: readonly string[];
}

export interface MergeOutcome {
  readonly targetId: string;
  readonly sourceId: string;
  readonly movedVariants: number;
  readonly mergedVariants: number;
  readonly movedMappings: number;
  readonly removedMappings: number;
  readonly archivedSourceId: string;
  readonly mergeLogId: string | null;
  readonly mergeLogRecorded: boolean;
  readonly warnings: readonly MergeWarning[];
  readonly channelPush: ChannelPushSummary;
}

export interface MergeBatchResult {
  readonly total: number;
  readonly merged: number;
  readonly failed: number;
  readonly results: readonly (
    | {
        readonly targetProductId: string;
        readonly sourceProductId: string;
        readonly ok: true;
        readonly result: MergeOutcome;
      }
    | {
        readonly targetProductId: string;
        readonly sourceProductId: string;
        readonly ok: false;
        readonly errorCode: string;
        readonly errorMessage: string;
      }
  )[];
}

export interface MergeLogEntry {
  readonly id: string;
  readonly targetProductId: string | null;
  readonly targetProductNo: string | null;
  readonly targetProductName: string | null;
  readonly sourceProductId: string | null;
  readonly sourceProductNo: string | null;
  readonly sourceProductName: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly undoneAt: string | null;
  readonly summary: {
    readonly movedVariants: number;
    readonly retiredVariants: number;
    readonly repointedMappings: number;
    readonly retiredMappings: number;
    readonly stockWarnings: number;
  };
}

export interface MergeUndoResult {
  readonly logId: string;
  readonly targetProductId: string | null;
  readonly restoredSourceProductId: string | null;
  readonly restoredVariants: number;
  readonly variantsMovedBack: number;
  readonly mappingsRestored: number;
  readonly mappingsRepointedBack: number;
  readonly skipped: readonly string[];
}

export interface MergeCandidate {
  readonly id: string;
  readonly productNo: string;
  readonly nameFa: string;
  readonly nameEn: string | null;
  readonly status: string;
  readonly categoryName: string | null;
  readonly sku: string | null;
  readonly variantCount: number;
  readonly updatedAt: string;
}

interface CandidateRow {
  readonly id: string;
  readonly product_no: string;
  readonly name: string;
  readonly name_en: string | null;
  readonly status: string;
  readonly category_name: string | null;
  readonly sku: string | null;
  readonly variant_count: string;
  readonly updated_at: Date | string;
}

export interface MergeExportRow {
  readonly productNo: string;
  readonly name: string;
  readonly sku: string;
  readonly source: string;
  readonly price: string;
  readonly stock: string;
  readonly suggestions: string;
}

export interface MergeImportResult {
  readonly total: number;
  readonly merged: number;
  readonly failed: number;
  readonly rows: readonly {
    readonly row: number;
    readonly sourceProductNo: string;
    readonly targetProductNo: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
}

/* ------------------------------------------------------------------ types -- */

interface ProductRow {
  readonly id: string;
  readonly public_id: string;
  readonly description: string | null;
  readonly category_id: string | null;
  readonly brand_id: string | null;
  readonly name_en: string | null;
  readonly name: string;
  readonly product_no: string;
  readonly status: string;
}

interface VariantRow {
  readonly id: string;
  readonly sku: string;
}

interface ProductCandidateRow {
  readonly id: string;
  readonly public_id: string;
  readonly product_no: string;
  readonly name: string;
  readonly source: string;
  readonly skus: string | null;
}

interface SuggestionRow {
  readonly a_id: string;
  readonly a_name: string;
  readonly a_source: string;
  readonly a_product_no: string;
  readonly a_skus: string | null;
  readonly b_id: string;
  readonly b_name: string;
  readonly b_source: string;
  readonly b_product_no: string;
  readonly b_skus: string | null;
  readonly similarity: string | number;
}

interface ExportRow {
  readonly id: string;
  readonly product_no: string;
  readonly name: string;
  readonly source: string;
  readonly sku: string | null;
  readonly price: string | null;
  readonly stock: string | null;
}

interface MergeLogRow {
  readonly id: string;
  readonly public_id: string;
  readonly target_product_id: string;
  readonly source_product_id: string;
  readonly snapshot: unknown;
  readonly created_at: Date | string;
  readonly created_by: string | null;
  readonly target_public_id: string | null;
  readonly target_product_no: string | null;
  readonly target_product_name: string | null;
  readonly source_public_id: string | null;
  readonly source_product_no: string | null;
  readonly source_product_name: string | null;
}

interface MergeSnapshot {
  readonly targetId: string;
  readonly sourceId: string;
  readonly sourceArchived: true;
  readonly mergedAt: string;
  /** Status the source had before the merge was archived (for a faithful undo). */
  readonly sourcePrevStatus?: string;
  readonly variantsMoved: readonly {
    readonly variantId: string;
    readonly sku: string;
    readonly toProductId: string;
  }[];
  readonly variantsRetired: readonly { readonly variantId: string; readonly sku: string }[];
  readonly mappingsRepointed: readonly {
    readonly mappingId: string;
    readonly fromVariantId: string;
    readonly toVariantId: string;
    readonly channelAccountId: string;
  }[];
  readonly mappingsRetired: readonly { readonly mappingId: string; readonly variantId: string }[];
  readonly stockWarnings: readonly {
    readonly variantId: string;
    readonly sku: string;
    readonly quantity: string;
  }[];
  readonly undoneAt?: string;
  readonly undoneBy?: string | null;
}

interface ParsedSnapshot extends MergeSnapshot {
  readonly summary: MergeLogEntry['summary'];
}

function emptyChannelPush(): ChannelPushSummary {
  return { accounts: [], triggered: [], failed: [] };
}

function splitSkus(value: string | null): string[] {
  if (value === null || value === '') return [];
  return value.split(String.fromCharCode(1)).filter((sku) => sku !== '');
}

function sharesSku(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((sku) => set.has(sku));
}

/**
 * Normalized character-bigram Dice coefficient — the fallback used when
 * `pg_trgm` is unavailable. Same 0..1 scale as `similarity()`.
 */
export function bigramSimilarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  let rightLength = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    rightLength += 1;
    const gram = right.slice(index, index + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  const leftLength = left.length - 1;
  return (2 * overlap) / (leftLength + rightLength);
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064b-\u0652\u0640]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseSnapshot(value: unknown): ParsedSnapshot | null {
  // postgres.js hands back jsonb as an object, but legacy rows written through
  // `JSON.stringify(...)::jsonb` were stored as a jsonb *string*. Normalize both.
  let normalized = value;
  if (typeof normalized === 'string') {
    try {
      normalized = JSON.parse(normalized);
    } catch {
      return null;
    }
  }
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) return null;
  const record = normalized as Record<string, unknown>;
  const arrayOf = (key: string): readonly Record<string, unknown>[] => {
    const raw = record[key];
    return Array.isArray(raw) ? (raw as readonly Record<string, unknown>[]) : [];
  };
  const textOf = (row: Record<string, unknown>, key: string): string =>
    typeof row[key] === 'string' ? (row[key] as string) : '';
  const stockWarnings = arrayOf('stockWarnings').map((row) => ({
    variantId: textOf(row, 'variantId'),
    sku: textOf(row, 'sku'),
    quantity: textOf(row, 'quantity'),
  }));
  return {
    targetId: textOf(record, 'targetId'),
    sourceId: textOf(record, 'sourceId'),
    sourceArchived: true,
    mergedAt: textOf(record, 'mergedAt'),
    variantsMoved: arrayOf('variantsMoved').map((row) => ({
      variantId: textOf(row, 'variantId'),
      sku: textOf(row, 'sku'),
      toProductId: textOf(row, 'toProductId'),
    })),
    variantsRetired: arrayOf('variantsRetired').map((row) => ({
      variantId: textOf(row, 'variantId'),
      sku: textOf(row, 'sku'),
    })),
    mappingsRepointed: arrayOf('mappingsRepointed').map((row) => ({
      mappingId: textOf(row, 'mappingId'),
      fromVariantId: textOf(row, 'fromVariantId'),
      toVariantId: textOf(row, 'toVariantId'),
      channelAccountId: textOf(row, 'channelAccountId'),
    })),
    mappingsRetired: arrayOf('mappingsRetired').map((row) => ({
      mappingId: textOf(row, 'mappingId'),
      variantId: textOf(row, 'variantId'),
    })),
    stockWarnings,
    ...(typeof record['sourcePrevStatus'] === 'string'
      ? { sourcePrevStatus: record['sourcePrevStatus'] }
      : {}),
    ...(typeof record['undoneAt'] === 'string' ? { undoneAt: record['undoneAt'] } : {}),
    ...(typeof record['undoneBy'] === 'string' || record['undoneBy'] === null
      ? { undoneBy: record['undoneBy'] as string | null }
      : {}),
    summary: {
      movedVariants: arrayOf('variantsMoved').length,
      retiredVariants: arrayOf('variantsRetired').length,
      repointedMappings: arrayOf('mappingsRepointed').length,
      retiredMappings: arrayOf('mappingsRetired').length,
      stockWarnings: stockWarnings.length,
    },
  };
}

@Injectable()
export class ProductMergeService {
  /** Detected once per process: `pg_trgm` similarity or the JS fallback. */
  private similarityMethod: SimilarityMethod | null = null;
  private trgmAttempted = false;
  private mergeLogAvailable: boolean | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly sync?: ChannelSyncService,
  ) {}

  /* ---------------------------------------------------------- suggestions -- */

  /**
   * Products the operator can pick as the duplicate in the manual picker.
   * `excludeId` keeps the current product out of its own merge picker.
   */
  async candidates(
    ctx: TenantContext,
    query: { readonly q?: string | undefined; readonly excludeId?: string | undefined },
  ): Promise<MergeCandidate[]> {
    const search = query.q === undefined || query.q === '' ? null : `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
    const excludeId = query.excludeId ?? null;
    const rows = await this.db<CandidateRow[]>`
      select p.public_id::text as id,
             p.product_no,
             p.name,
             p.name_en,
             p.status,
             c.name as category_name,
             (
               select v.sku from erp.product_variants v
               where v.product_id = p.id and v.deleted_at is null
               order by v.is_default desc, v.sort_order, v.id
               limit 1
             ) as sku,
             (
               select count(*) from erp.product_variants v
               where v.product_id = p.id and v.deleted_at is null
             )::text as variant_count,
             p.updated_at
      from erp.products p
      left join erp.product_categories c on c.id = p.category_id and c.deleted_at is null
      where p.organization_id = ${ctx.orgId}
        and p.deleted_at is null
        and (${excludeId}::uuid is null or p.public_id <> ${excludeId}::uuid)
        and (
          ${search}::text is null
          or p.name ilike ${search}
          or p.name_en ilike ${search}
          or p.product_no ilike ${search}
          or exists (
            select 1 from erp.product_variants v
            where v.product_id = p.id and v.deleted_at is null and v.sku ilike ${search}
          )
        )
      order by p.updated_at desc, p.id desc
      limit 20
    `;
    return rows.map((row) => ({
      id: row.id,
      productNo: row.product_no,
      nameFa: row.name,
      nameEn: row.name_en,
      status: row.status,
      categoryName: row.category_name,
      sku: row.sku,
      variantCount: Number(row.variant_count),
      updatedAt: toIsoRequired(row.updated_at),
    }));
  }

  async suggestions(
    ctx: TenantContext,
    limit: number,
  ): Promise<{ items: SuggestionPair[]; similarityMethod: SimilarityMethod }> {
    const capped = Math.min(Math.max(limit, 1), MAX_SUGGESTION_LIMIT);
    const method = await this.resolveSimilarityMethod();
    const pairs =
      method === 'pg_trgm'
        ? await this.trigramPairs(ctx, capped, MIN_SIMILARITY, MAX_PRODUCTS_SCANNED)
        : await this.bigramPairs(ctx, capped, MIN_SIMILARITY, MAX_PRODUCTS_SCANNED);
    return { items: pairs, similarityMethod: method };
  }

  private async resolveSimilarityMethod(): Promise<SimilarityMethod> {
    if (this.similarityMethod !== null) return this.similarityMethod;
    const rows = await this.db<{ present: boolean }[]>`
      select exists (select 1 from pg_extension where extname = 'pg_trgm') as present
    `;
    let present = rows[0]?.present === true;
    if (!present && !this.trgmAttempted) {
      this.trgmAttempted = true;
      try {
        await this.db.unsafe('create extension if not exists pg_trgm');
        present = true;
      } catch {
        present = false;
      }
    }
    this.similarityMethod = present ? 'pg_trgm' : 'normalized_bigram_dice';
    return this.similarityMethod;
  }

  /** Server-side trigram similarity (`similarity()` from `pg_trgm`). */
  private async trigramPairs(
    ctx: TenantContext,
    limit: number,
    minSimilarity: number,
    maxProducts: number,
  ): Promise<SuggestionPair[]> {
    const rows = await this.db.unsafe<SuggestionRow[]>(
      `with ${SOURCES_CTE},
       prods as (
         select p.id, p.public_id::text as public_id, p.product_no, p.name,
                coalesce(s.source, 'manual') as source,
                ${NORMALIZED_NAME} as norm,
                ${SKUS_SUBQUERY} as skus
         from erp.products p
         left join sources s on s.product_id = p.id
         where p.organization_id = $1 and p.deleted_at is null and p.status = 'active'
         order by p.updated_at desc, p.id desc
         limit $4
       )
       select a.public_id as a_id, a.name as a_name, a.source as a_source,
              a.product_no as a_product_no, a.skus as a_skus,
              b.public_id as b_id, b.name as b_name, b.source as b_source,
              b.product_no as b_product_no, b.skus as b_skus,
              similarity(a.norm, b.norm) as similarity
       from prods a
       join prods b on a.id < b.id
       where a.source <> b.source
         and (a.source in ('carexy', 'digikala') or b.source in ('carexy', 'digikala'))
         and similarity(a.norm, b.norm) >= $2
       order by similarity(a.norm, b.norm) desc, a.product_no, b.product_no
       limit $3`,
      [ctx.orgId.toString(), minSimilarity, limit, maxProducts],
    );
    return rows.map((row) => this.toPair(row));
  }

  /** In-process fallback: normalized character-bigram Dice over candidate products. */
  private async bigramPairs(
    ctx: TenantContext,
    limit: number,
    minSimilarity: number,
    maxProducts: number,
  ): Promise<SuggestionPair[]> {
    const rows = await this.db.unsafe<ProductCandidateRow[]>(
      `with ${SOURCES_CTE}
       select p.public_id::text as public_id,
              p.id::text as id,
              p.product_no,
              p.name,
              coalesce(s.source, 'manual') as source,
              ${SKUS_SUBQUERY} as skus
       from erp.products p
       left join sources s on s.product_id = p.id
       where p.organization_id = $1
         and p.deleted_at is null
         and p.status = 'active'
       order by p.updated_at desc, p.id desc
       limit $2`,
      [ctx.orgId.toString(), maxProducts],
    );

    const pairs: SuggestionPair[] = [];
    for (let left = 0; left < rows.length; left += 1) {
      const a = rows[left];
      if (a === undefined) continue;
      for (let right = left + 1; right < rows.length; right += 1) {
        const b = rows[right];
        if (b === undefined) continue;
        if (a.source === b.source) continue;
        if (!isImportSource(a.source) && !isImportSource(b.source)) continue;
        const similarity = bigramSimilarity(a.name, b.name);
        if (similarity < minSimilarity) continue;
        pairs.push({
          aId: a.public_id,
          aName: a.name,
          aSource: a.source,
          aProductNo: a.product_no,
          bId: b.public_id,
          bName: b.name,
          bSource: b.source,
          bProductNo: b.product_no,
          similarity: Math.round(similarity * 1000) / 1000,
          sameSku: sharesSku(splitSkus(a.skus), splitSkus(b.skus)),
        });
      }
    }
    pairs.sort((left, right) => right.similarity - left.similarity);
    return pairs.slice(0, limit);
  }

  private toPair(row: SuggestionRow): SuggestionPair {
    return {
      aId: row.a_id,
      aName: row.a_name,
      aSource: row.a_source,
      aProductNo: row.a_product_no,
      bId: row.b_id,
      bName: row.b_name,
      bSource: row.b_source,
      bProductNo: row.b_product_no,
      similarity: Math.round(Number(row.similarity) * 1000) / 1000,
      sameSku: sharesSku(splitSkus(row.a_skus), splitSkus(row.b_skus)),
    };
  }

  /* --------------------------------------------------------------- merge -- */

  async merge(ctx: TenantContext, targetPublicId: string, sourcePublicId: string): Promise<MergeOutcome> {
    if (targetPublicId === sourcePublicId) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'محصول مبدأ و مقصد نمی‌توانند یکی باشند.',
        details: [{ field: 'sourceProductId', rule: 'same_product' }],
      });
    }

    const merged = await this.mergeInTx(ctx, targetPublicId, sourcePublicId);
    const channelPush = await this.propagateForVariants(ctx, merged.targetVariantIds);
    return { ...merged.outcome, channelPush };
  }

  private async mergeInTx(
    ctx: TenantContext,
    targetPublicId: string,
    sourcePublicId: string,
  ): Promise<{ outcome: MergeOutcome; targetVariantIds: string[] }> {
    return this.db.begin(async (tx) => {
      const products = await tx<ProductRow[]>`
        select id::text as id,
               public_id::text as public_id,
               description,
               category_id::text as category_id,
               brand_id::text as brand_id,
               name_en,
               name,
               product_no,
               status
        from erp.products
        where organization_id = ${ctx.orgId}
          and public_id in (${targetPublicId}, ${sourcePublicId})
          and deleted_at is null
        for update
      `;
      const target = products.find((row) => row.public_id === targetPublicId);
      const source = products.find((row) => row.public_id === sourcePublicId);
      if (target === undefined) throw notFound('product');
      if (source === undefined) throw notFound('product');

      const sourceVariants = await tx<VariantRow[]>`
        select id::text as id, sku
        from erp.product_variants
        where product_id = ${source.id}::bigint and deleted_at is null
        order by id
      `;
      const targetVariants = await tx<VariantRow[]>`
        select id::text as id, sku
        from erp.product_variants
        where product_id = ${target.id}::bigint and deleted_at is null
        order by id
      `;
      const targetBySku = new Map(targetVariants.map((variant) => [variant.sku, variant.id]));

      const variantsMoved: { variantId: string; sku: string; toProductId: string }[] = [];
      const variantsRetired: { variantId: string; sku: string }[] = [];
      const mappingsRepointed: {
        mappingId: string;
        fromVariantId: string;
        toVariantId: string;
        channelAccountId: string;
      }[] = [];
      const mappingsRetired: { mappingId: string; variantId: string }[] = [];
      const matchedVariantIds: string[] = [];

      for (const variant of sourceVariants) {
        const match = targetBySku.get(variant.sku);
        if (match === undefined) {
          await tx`
            update erp.product_variants
            set product_id = ${target.id}::bigint,
                is_default = case
                  when exists (
                    select 1 from erp.product_variants d
                    where d.product_id = ${target.id}::bigint
                      and d.deleted_at is null
                      and d.is_default
                  ) then false
                  else is_default
                end,
                updated_by = ${ctx.actorId}
            where id = ${variant.id}::bigint
          `;
          variantsMoved.push({ variantId: variant.id, sku: variant.sku, toProductId: target.public_id });
          continue;
        }

        matchedVariantIds.push(variant.id);
        const moved = await tx<{ id: string; channel_account_id: string }[]>`
          update erp.channel_product_mappings m
          set product_variant_id = ${match}::bigint,
              sync_status = 'pending',
              updated_by = ${ctx.actorId}
          where m.product_variant_id = ${variant.id}::bigint
            and m.deleted_at is null
            and not exists (
              select 1 from erp.channel_product_mappings t
              where t.channel_account_id = m.channel_account_id
                and t.product_variant_id = ${match}::bigint
                and t.deleted_at is null
            )
          returning m.id::text as id, m.channel_account_id::text as channel_account_id
        `;
        for (const row of moved) {
          mappingsRepointed.push({
            mappingId: row.id,
            fromVariantId: variant.id,
            toVariantId: match,
            channelAccountId: row.channel_account_id,
          });
        }

        // A mapping that already exists on the target for the same channel
        // account cannot be re-pointed (partial unique index); retire it with
        // the duplicate variant so the channel keeps exactly one active link.
        const retired = await tx<{ id: string }[]>`
          update erp.channel_product_mappings
          set deleted_at = now(), updated_by = ${ctx.actorId}
          where product_variant_id = ${variant.id}::bigint
            and deleted_at is null
          returning id::text as id
        `;
        for (const row of retired) {
          mappingsRetired.push({ mappingId: row.id, variantId: variant.id });
        }

        await tx`
          update erp.product_variants
          set deleted_at = now(),
              is_active = false,
              updated_by = ${ctx.actorId}
          where id = ${variant.id}::bigint
        `;
        variantsRetired.push({ variantId: variant.id, sku: variant.sku });
      }

      const stockWarnings = await this.stockOnVariants(tx, matchedVariantIds);

      // Fill only missing master data; never overwrite what the target owns.
      await tx`
        update erp.products
        set description = case
              when description is null or btrim(description) = '' then ${source.description}
              else description
            end,
            category_id = coalesce(category_id, ${source.category_id}::bigint),
            brand_id = coalesce(brand_id, ${source.brand_id}::bigint),
            name_en = case
              when name_en is null or btrim(name_en) = '' then ${source.name_en}
              else name_en
            end,
            updated_by = ${ctx.actorId}
        where id = ${target.id}::bigint
      `;

      await tx`
        update erp.products
        set deleted_at = now(),
            status = 'archived',
            updated_by = ${ctx.actorId}
        where id = ${source.id}::bigint
      `;

      const snapshot: MergeSnapshot = {
        targetId: target.public_id,
        sourceId: source.public_id,
        sourceArchived: true,
        mergedAt: new Date().toISOString(),
        sourcePrevStatus: source.status,
        variantsMoved,
        variantsRetired,
        mappingsRepointed,
        mappingsRetired,
        stockWarnings,
      };

      const warnings: MergeWarning[] = stockWarnings.map((warning) => ({
        code: 'stock_left_on_archived_variant',
        messageFa:
          'موجودی تنوع تکراری روی همان تنوع آرشیوشده باقی ماند؛ برای انتقال موجودی از سند اصلاح موجودی استفاده کنید.',
        variantId: warning.variantId,
        sku: warning.sku,
      }));

      let mergeLogId: string | null = null;
      let mergeLogRecorded = false;
      const logAvailable = await this.hasMergeLogTable(tx);
      if (logAvailable) {
        const inserted = await tx<{ public_id: string }[]>`
          insert into erp.product_merge_log
            (organization_id, target_product_id, source_product_id, snapshot, created_by)
          values (
            ${ctx.orgId},
            ${target.id}::bigint,
            ${source.id}::bigint,
            ${snapshot}::jsonb,
            ${ctx.actorId}
          )
          returning public_id::text as public_id
        `;
        mergeLogId = inserted[0]?.public_id ?? null;
        mergeLogRecorded = true;
      } else {
        warnings.push({
          code: 'merge_log_unavailable',
          messageFa: 'جدول تاریخچه ادغام در دسترس نیست؛ این ادغام قابل بازگردانی از صفحه تاریخچه نیست.',
        });
      }

      const targetVariantIds = targetVariants
        .map((variant) => variant.id)
        .concat(variantsMoved.map((variant) => variant.variantId));

      return {
        targetVariantIds,
        outcome: {
          targetId: target.public_id,
          sourceId: source.public_id,
          movedVariants: variantsMoved.length,
          mergedVariants: variantsRetired.length,
          movedMappings: mappingsRepointed.length,
          removedMappings: mappingsRetired.length,
          archivedSourceId: source.public_id,
          mergeLogId,
          mergeLogRecorded,
          warnings,
          channelPush: emptyChannelPush(),
        },
      };
    });
  }

  /** Stock that stays behind on a duplicate variant folded into the target. */
  private async stockOnVariants(
    tx: Db,
    variantIds: readonly string[],
  ): Promise<{ variantId: string; sku: string; quantity: string }[]> {
    if (variantIds.length === 0) return [];
    const rows = await tx<{ variant_id: string; sku: string; quantity: string }[]>`
      select b.product_variant_id::text as variant_id,
             v.sku,
             sum(b.on_hand)::text as quantity
      from erp.inventory_balances b
      join erp.product_variants v on v.id = b.product_variant_id
      where b.product_variant_id = any(${variantIds.map((id) => id.toString())}::bigint[])
      group by b.product_variant_id, v.sku
      having sum(b.on_hand) > 0
    `;
    return rows.map((row) => ({
      variantId: row.variant_id,
      sku: row.sku,
      quantity: row.quantity,
    }));
  }

  private async hasMergeLogTable(db: Db): Promise<boolean> {
    // Only a positive answer is cached: a later migration must become visible
    // without restarting the API process.
    if (this.mergeLogAvailable === true) return true;
    try {
      const rows = await db<{ present: boolean }[]>`
        select to_regclass('erp.product_merge_log') is not null as present
      `;
      this.mergeLogAvailable = rows[0]?.present === true;
    } catch {
      this.mergeLogAvailable = false;
    }
    return this.mergeLogAvailable;
  }

  /**
   * Price/stock propagation for the surviving product. Every trigger is isolated:
   * a channel outage must never fail (or roll back) the merge.
   */
  private async propagateForVariants(
    ctx: TenantContext,
    variantIds: readonly string[],
  ): Promise<ChannelPushSummary> {
    const sync = this.sync;
    if (sync === undefined || variantIds.length === 0) return emptyChannelPush();
    let accounts: { account_id: string }[];
    try {
      accounts = await this.db<{ account_id: string }[]>`
        select distinct a.id::text as account_id
        from erp.channel_product_mappings m
        join erp.channel_accounts a on a.id = m.channel_account_id
        join erp.sales_channels ch on ch.id = a.channel_id
        where m.product_variant_id = any(${variantIds.map((id) => id.toString())}::bigint[])
          and m.deleted_at is null
          and a.deleted_at is null
          and a.is_active
          and ch.is_active
      `;
    } catch {
      return emptyChannelPush();
    }

    const triggered: string[] = [];
    const failed: string[] = [];
    for (const account of accounts) {
      for (const type of ['inventory_push', 'price_push'] as const) {
        try {
          const job = await sync.trigger({
            organizationId: ctx.orgId.toString(),
            accountId: account.account_id,
            type,
            force: true,
          });
          triggered.push(`${account.account_id}:${type}`);
          setImmediate(() => {
            void sync.runJob(job.jobId).catch(() => undefined);
          });
        } catch {
          failed.push(`${account.account_id}:${type}`);
        }
      }
    }
    return { accounts: accounts.map((account) => account.account_id), triggered, failed };
  }

  async mergeBatch(ctx: TenantContext, pairs: readonly MergePairInput[]): Promise<MergeBatchResult> {
    const results: MergeBatchResult['results'][number][] = [];
    let merged = 0;
    for (const pair of pairs) {
      try {
        const result = await this.merge(ctx, pair.targetProductId, pair.sourceProductId);
        merged += 1;
        results.push({
          targetProductId: pair.targetProductId,
          sourceProductId: pair.sourceProductId,
          ok: true,
          result,
        });
      } catch (error) {
        const appError = error instanceof AppError ? error : null;
        results.push({
          targetProductId: pair.targetProductId,
          sourceProductId: pair.sourceProductId,
          ok: false,
          errorCode: appError?.code ?? 'INTERNAL',
          errorMessage: appError?.message ?? 'ادغام این جفت انجام نشد.',
        });
      }
    }
    return { total: pairs.length, merged, failed: pairs.length - merged, results };
  }

  /* ---------------------------------------------------------------- log -- */

  async listMerges(ctx: TenantContext, limit: number): Promise<MergeLogEntry[]> {
    if (!(await this.hasMergeLogTable(this.db))) return [];
    const rows = await this.db<MergeLogRow[]>`
      select l.public_id::text as public_id,
             l.id::text as id,
             l.target_product_id::text as target_product_id,
             l.source_product_id::text as source_product_id,
             l.snapshot,
             l.created_at,
             l.created_by::text as created_by,
             tp.public_id::text as target_public_id,
             tp.product_no as target_product_no,
             tp.name as target_product_name,
             sp.public_id::text as source_public_id,
             sp.product_no as source_product_no,
             sp.name as source_product_name
      from erp.product_merge_log l
      left join erp.products tp on tp.id = l.target_product_id
      left join erp.products sp on sp.id = l.source_product_id
      where l.organization_id = ${ctx.orgId}
      order by l.created_at desc, l.id desc
      limit ${Math.min(Math.max(limit, 1), 200)}
    `;
    return rows.map((row) => {
      const snapshot = parseSnapshot(row.snapshot);
      return {
        id: row.public_id,
        targetProductId: row.target_public_id,
        targetProductNo: row.target_product_no,
        targetProductName: row.target_product_name,
        sourceProductId: row.source_public_id,
        sourceProductNo: row.source_product_no,
        sourceProductName: row.source_product_name,
        createdBy: row.created_by,
        createdAt: toIsoRequired(row.created_at),
        undoneAt: snapshot?.undoneAt ?? null,
        summary: snapshot?.summary ?? {
          movedVariants: 0,
          retiredVariants: 0,
          repointedMappings: 0,
          retiredMappings: 0,
          stockWarnings: 0,
        },
      };
    });
  }

  /**
   * Restores a merge: the source product is un-archived, moved variants and
   * mappings go back, retired variants/mappings are revived. Conflicting active
   * mappings are skipped (the partial unique index forbids two active rows for
   * the same account × variant) and reported.
   */
  async undo(ctx: TenantContext, logPublicId: string): Promise<MergeUndoResult> {
    if (!(await this.hasMergeLogTable(this.db))) throw notFound('merge_log');

    return this.db.begin(async (tx) => {
      const rows = await tx<MergeLogRow[]>`
        select l.public_id::text as public_id,
               l.id::text as id,
               l.target_product_id::text as target_product_id,
               l.source_product_id::text as source_product_id,
               l.snapshot,
               l.created_at,
               l.created_by::text as created_by,
               null::text as target_public_id,
               null::text as target_product_no,
               null::text as target_product_name,
               null::text as source_public_id,
               null::text as source_product_no,
               null::text as source_product_name
        from erp.product_merge_log l
        where l.organization_id = ${ctx.orgId}
          and l.public_id = ${logPublicId}
        for update
      `;
      const row = rows[0];
      if (row === undefined) throw notFound('merge_log');

      const snapshot = parseSnapshot(row.snapshot);
      if (snapshot === null) {
        throw new AppError('CONFLICT', {
          message: 'اطلاعات این ادغام ناقص است و قابل بازگردانی نیست.',
          details: [{ rule: 'merge_snapshot_missing' }],
        });
      }
      if (snapshot.undoneAt !== undefined) {
        throw new AppError('CONFLICT', {
          message: 'این ادغام قبلاً بازگردانی شده است.',
          details: [{ rule: 'merge_already_undone' }],
        });
      }

      const skipped: string[] = [];
      let restoredVariants = 0;
      let variantsMovedBack = 0;
      let mappingsRestored = 0;
      let mappingsRepointedBack = 0;

      // 1) Un-archive the source product (may hit the active product_no index).
      try {
        await tx`
          update erp.products
          set deleted_at = null,
              status = ${snapshot.sourcePrevStatus ?? 'active'},
              updated_by = ${ctx.actorId}
          where id = ${row.source_product_id}::bigint
            and organization_id = ${ctx.orgId}
        `;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new AppError('CONFLICT', {
            message: 'شماره محصول مبدأ پس از ادغام توسط محصول دیگری گرفته شده است؛ بازگردانی ممکن نیست.',
            details: [{ rule: 'source_product_no_taken' }],
          });
        }
        throw error;
      }

      // 2) Revive duplicate-SKU variants under the source product.
      if (snapshot.variantsRetired.length > 0) {
        const ids = snapshot.variantsRetired.map((variant) => variant.variantId);
        const revived = await tx<{ id: string }[]>`
          update erp.product_variants
          set deleted_at = null,
              is_active = true,
              product_id = ${row.source_product_id}::bigint,
              updated_by = ${ctx.actorId}
          where id = any(${ids.map((id) => id.toString())}::bigint[])
          returning id::text as id
        `;
        restoredVariants = revived.length;
      }

      // 3) Move the unmatched variants back to the source product.
      if (snapshot.variantsMoved.length > 0) {
        const ids = snapshot.variantsMoved.map((variant) => variant.variantId);
        const moved = await tx<{ id: string }[]>`
          update erp.product_variants
          set product_id = ${row.source_product_id}::bigint,
              updated_by = ${ctx.actorId}
          where id = any(${ids.map((id) => id.toString())}::bigint[])
            and deleted_at is null
          returning id::text as id
        `;
        variantsMovedBack = moved.length;
      }

      // 4) Re-point mappings that were moved onto the target variant.
      for (const mapping of snapshot.mappingsRepointed) {
        const restored = await tx<{ id: string }[]>`
          update erp.channel_product_mappings m
          set product_variant_id = ${mapping.fromVariantId}::bigint,
              sync_status = 'pending',
              updated_by = ${ctx.actorId}
          where m.id = ${mapping.mappingId}::bigint
            and m.deleted_at is null
            and not exists (
              select 1 from erp.channel_product_mappings t
              where t.channel_account_id = m.channel_account_id
                and t.product_variant_id = ${mapping.fromVariantId}::bigint
                and t.deleted_at is null
                and t.id <> m.id
            )
          returning m.id::text as id
        `;
        if (restored.length > 0) mappingsRepointedBack += 1;
        else skipped.push(`mapping:${mapping.mappingId}:conflict_or_missing`);
      }

      // 5) Revive mappings that were retired with the duplicate variant.
      for (const mapping of snapshot.mappingsRetired) {
        const restored = await tx<{ id: string }[]>`
          update erp.channel_product_mappings m
          set deleted_at = null,
              sync_status = 'pending',
              updated_by = ${ctx.actorId}
          where m.id = ${mapping.mappingId}::bigint
            and not exists (
              select 1 from erp.channel_product_mappings t
              where t.channel_account_id = m.channel_account_id
                and t.product_variant_id = ${mapping.variantId}::bigint
                and t.deleted_at is null
                and t.id <> m.id
            )
          returning m.id::text as id
        `;
        if (restored.length > 0) mappingsRestored += 1;
        else skipped.push(`mapping:${mapping.mappingId}:conflict_or_missing`);
      }

      // 6) Mark the log row as undone through its snapshot (no column churn).
      await tx`
        update erp.product_merge_log
        set snapshot = jsonb_set(
              jsonb_set(
                case
                  when jsonb_typeof(coalesce(snapshot, '{}'::jsonb)) = 'object'
                    then coalesce(snapshot, '{}'::jsonb)
                  else (coalesce(snapshot, '{}'::jsonb) #>> '{}')::jsonb
                end,
                '{undoneAt}',
                to_jsonb(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
                true
              ),
              '{undoneBy}',
              ${JSON.stringify(ctx.actorId === null ? null : ctx.actorId.toString())}::jsonb,
              true
            )
        where id = ${row.id}::bigint
      `;

      return {
        logId: row.public_id,
        targetProductId: snapshot.targetId === '' ? null : snapshot.targetId,
        restoredSourceProductId: snapshot.sourceId === '' ? null : snapshot.sourceId,
        restoredVariants,
        variantsMovedBack,
        mappingsRestored,
        mappingsRepointedBack,
        skipped,
      };
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { code?: unknown }).code === '23505';
  }

  /* ------------------------------------------------------- export / import -- */

  async exportRows(ctx: TenantContext): Promise<{ source: SimilarityMethod; rows: MergeExportRow[] }> {
    const method = await this.resolveSimilarityMethod();
    const pairs =
      method === 'pg_trgm'
        ? await this.trigramPairs(ctx, 20_000, MIN_SIMILARITY, MAX_EXPORT_ROWS)
        : await this.bigramPairs(ctx, 20_000, MIN_SIMILARITY, MAX_EXPORT_ROWS);

    const bestMatch = new Map<string, { name: string; similarity: number }>();
    for (const pair of pairs) {
      const currentA = bestMatch.get(pair.aId);
      if (currentA === undefined || currentA.similarity < pair.similarity) {
        bestMatch.set(pair.aId, { name: pair.bName, similarity: pair.similarity });
      }
      const currentB = bestMatch.get(pair.bId);
      if (currentB === undefined || currentB.similarity < pair.similarity) {
        bestMatch.set(pair.bId, { name: pair.aName, similarity: pair.similarity });
      }
    }

    const rows = await this.db.unsafe<ExportRow[]>(
      `with ${SOURCES_CTE}
       select p.public_id::text as id,
              p.product_no,
              p.name,
              coalesce(s.source, 'manual') as source,
              dv.sku,
              pr.price_amount::text as price,
              coalesce(st.on_hand, 0)::text as stock
       from erp.products p
       left join sources s on s.product_id = p.id
       left join lateral (
         select v.id, v.sku
         from erp.product_variants v
         where v.product_id = p.id and v.deleted_at is null
         order by v.is_default desc, v.sort_order, v.id
         limit 1
       ) dv on true
       left join lateral (
         select i.price_amount
         from erp.price_list_items i
         where i.product_variant_id = dv.id
           and i.deleted_at is null
           and i.is_active
           and i.effective_from <= now()
           and (i.effective_to is null or i.effective_to > now())
         order by i.effective_from desc, i.id desc
         limit 1
       ) pr on true
       left join lateral (
         select sum(b.on_hand) as on_hand
         from erp.inventory_balances b
         where b.product_variant_id in (
             select v.id from erp.product_variants v
             where v.product_id = p.id and v.deleted_at is null
           )
       ) st on true
       where p.organization_id = $1
         and p.deleted_at is null
         and p.status = 'active'
       order by p.updated_at desc, p.id desc
       limit $2`,
      [ctx.orgId.toString(), MAX_EXPORT_ROWS],
    );

    return {
      source: method,
      rows: rows.map((row) => {
        const suggestion = bestMatch.get(row.id);
        return {
          productNo: row.product_no,
          name: row.name,
          sku: row.sku ?? '',
          source: row.source,
          price: row.price ?? '',
          stock: row.stock ?? '0',
          suggestions:
            suggestion === undefined
              ? ''
              : `${suggestion.name} (${Math.round(suggestion.similarity * 100)}%)`,
        };
      }),
    };
  }

  /** Serializes the export to `.xlsx` bytes (dependency-free OOXML writer). */
  async exportXlsx(ctx: TenantContext): Promise<{ fileName: string; buffer: Buffer }> {
    const { rows } = await this.exportRows(ctx);
    const buffer = buildXlsx({
      name: 'merge',
      columns: [
        { header: 'productNo' },
        { header: 'name' },
        { header: 'sku' },
        { header: 'source' },
        { header: 'price' },
        { header: 'stock' },
        { header: 'suggestions' },
      ],
      rows: rows.map((row) => [
        row.productNo,
        row.name,
        row.sku,
        row.source,
        row.price,
        row.stock,
        row.suggestions,
      ]),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return { fileName: `product-merge-${stamp}.xlsx`, buffer };
  }

  /**
   * Applies merges from an uploaded workbook. Columns `sourceProductNo` and
   * `targetProductNo` are read by header name (case-insensitive); every row is
   * merged independently so one bad row cannot abort the file.
   */
  async importXlsx(ctx: TenantContext, base64: string): Promise<MergeImportResult> {
    const buffer = this.decodeBase64File(base64);
    const rows = readXlsxRows(buffer);
    if (rows.length === 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'فایل اکسل خالی است یا ساختار آن خوانده نشد.',
        details: [{ field: 'file', rule: 'xlsx_unreadable' }],
      });
    }

    const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
    const sourceIndex = header.indexOf('sourceproductno');
    const targetIndex = header.indexOf('targetproductno');
    if (sourceIndex < 0 || targetIndex < 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'ستون‌های sourceProductNo و targetProductNo در سطر اول فایل یافت نشد.',
        details: [{ field: 'file', rule: 'xlsx_missing_columns' }],
      });
    }

    const byProductNo = await this.db<{ product_no: string; public_id: string }[]>`
      select p.product_no, p.public_id::text as public_id
      from erp.products p
      where p.organization_id = ${ctx.orgId}
        and p.deleted_at is null
    `;
    const idByProductNo = new Map(byProductNo.map((row) => [row.product_no, row.public_id]));

    const results: MergeImportResult['rows'][number][] = [];
    let merged = 0;
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      const sourceProductNo = (row[sourceIndex] ?? '').trim();
      const targetProductNo = (row[targetIndex] ?? '').trim();
      if (sourceProductNo === '' && targetProductNo === '') continue;

      const sourceId = idByProductNo.get(sourceProductNo);
      const targetId = idByProductNo.get(targetProductNo);
      if (sourceId === undefined || targetId === undefined) {
        const missing = [
          ...(sourceId === undefined ? [`source:${sourceProductNo}`] : []),
          ...(targetId === undefined ? [`target:${targetProductNo}`] : []),
        ].join(', ');
        results.push({
          row: index + 1,
          sourceProductNo,
          targetProductNo,
          ok: false,
          error: `product_not_found (${missing})`,
        });
        continue;
      }
      try {
        await this.merge(ctx, targetId, sourceId);
        merged += 1;
        results.push({ row: index + 1, sourceProductNo, targetProductNo, ok: true });
      } catch (error) {
        results.push({
          row: index + 1,
          sourceProductNo,
          targetProductNo,
          ok: false,
          error: error instanceof AppError ? error.message : 'merge_failed',
        });
      }
    }

    return { total: results.length, merged, failed: results.length - merged, rows: results };
  }

  private decodeBase64File(value: string): Buffer {
    const normalized = value.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (normalized === '' || /[^A-Za-z0-9+/=]/.test(normalized)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'محتوای فایل ارسالی base64 معتبر نیست.',
        details: [{ field: 'file', rule: 'invalid_base64' }],
      });
    }
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'فایل ارسالی خالی است.',
        details: [{ field: 'file', rule: 'empty_file' }],
      });
    }
    if (buffer.length > 2 * 1024 * 1024) {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        message: 'حجم فایل اکسل بیش از ۲ مگابایت است.',
        details: [{ field: 'file', rule: 'file_too_large' }],
      });
    }
    return buffer;
  }
}

export { DEFAULT_SUGGESTION_LIMIT, MAX_SUGGESTION_LIMIT };
