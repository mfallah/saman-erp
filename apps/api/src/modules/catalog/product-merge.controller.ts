/**
 * Product merge workbench — HTTP surface (`/api/v1/products/...`).
 *
 * Routes (all org-scoped, permission-gated):
 * - `GET  /products/merge/candidates`      search products for the manual picker
 * - `GET  /products/merge/suggestions`     duplicate candidates from Carexy + Digikala
 * - `POST /products/:targetId/merge`       single manual merge (kept for the list page)
 * - `POST /products/merge/batch`           merge many pairs, per-pair results
 * - `GET  /products/merges`                merge log with product names
 * - `POST /products/merges/:id/undo`       restore a logged merge
 * - `GET  /products/merge/export.xlsx`     workbook of products + best suggestion
 * - `POST /products/merge/import.xlsx`     workbook with sourceProductNo/targetProductNo
 *
 * The import endpoint takes JSON `{ "file": "<base64 xlsx>" }` rather than
 * multipart: the app does not register `@fastify/multipart`, and the shared
 * JSON body cap (2 MB) is enough for the few-thousand-row merge sheets this
 * screen produces. The decoded workbook is capped at 2 MB as well.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { TenantContext } from '../../common/contracts';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { PublicId, parseWith } from './dto/common';
import { DEFAULT_SUGGESTION_LIMIT, MAX_SUGGESTION_LIMIT, ProductMergeService } from './product-merge.service';

const MergeParams = z.object({ targetId: PublicId });
const MergeBody = z.object({ sourceProductId: PublicId });
const CandidatesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  excludeId: PublicId.optional(),
});
/**
 * The workbench is not paginated, but the shared web client may append
 * `page`/`perPage`. Accept and ignore them instead of rejecting the request.
 */
const PagingParams = {
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).optional(),
};
const SuggestionsQuery = z.object({
  ...PagingParams,
  limit: z.coerce.number().int().min(1).max(MAX_SUGGESTION_LIMIT).default(DEFAULT_SUGGESTION_LIMIT),
});
const MergeLogQuery = z.object({
  ...PagingParams,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const UndoParams = z.object({ id: PublicId });
const BatchBody = z.object({
  pairs: z
    .array(z.object({ targetProductId: PublicId, sourceProductId: PublicId }))
    .min(1)
    .max(200),
});
const ImportBody = z.object({
  /** Base64 (optionally a `data:...;base64,` URL) of the `.xlsx` workbook. */
  file: z.string().min(1).max(3_000_000),
});

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('products')
export class ProductMergeController {
  constructor(private readonly merge: ProductMergeService) {}

  @Get('merge/candidates')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Search products for the manual merge picker' })
  async candidates(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const parsed = parseWith(CandidatesQuery, query);
    return apiData(await this.merge.candidates(ctx, parsed));
  }

  @Get('merge/suggestions')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Duplicate candidates from Carexy + Digikala by name similarity' })
  async suggestions(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const { limit } = parseWith(SuggestionsQuery, query);
    const result = await this.merge.suggestions(ctx, limit);
    return apiData(result.items, {
      limit,
      minSimilarity: 0.55,
      similarityMethod: result.similarityMethod,
    });
  }

  /** Folds the source duplicate into the target product in one transaction. */
  @Post(':targetId/merge')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.merge')
  @ApiOperation({ summary: 'Merge a duplicate product into this one (manual)' })
  async mergeOne(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { targetId } = parseWith(MergeParams, params);
    const { sourceProductId } = parseWith(MergeBody, body);
    return apiData(await this.merge.merge(ctx, targetId, sourceProductId));
  }

  @Post('merge/batch')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.merge')
  @ApiOperation({ summary: 'Merge many duplicate pairs; failures do not abort the batch' })
  async batch(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const { pairs } = parseWith(BatchBody, body);
    return apiData(await this.merge.mergeBatch(ctx, pairs));
  }

  @Get('merges')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Merge history with product names' })
  async merges(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const { limit } = parseWith(MergeLogQuery, query);
    return apiData(await this.merge.listMerges(ctx, limit));
  }

  @Post('merges/:id/undo')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.merge.undo')
  @ApiOperation({ summary: 'Undo a logged merge (restore source product, variants and mappings)' })
  async undo(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(UndoParams, params);
    return apiData(await this.merge.undo(ctx, id));
  }

  /**
   * Binary endpoint: bypasses the JSON envelope on purpose (same pattern as the
   * label SVG response), so the browser downloads a real workbook.
   */
  @Get('merge/export.xlsx')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Download products + best merge suggestion as .xlsx' })
  async exportXlsx(@CurrentTenant() ctx: TenantContext, @Res() reply: FastifyReply): Promise<void> {
    const { fileName, buffer } = await this.merge.exportXlsx(ctx);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .send(buffer);
  }

  @Post('merge/import.xlsx')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.merge')
  @ApiOperation({ summary: 'Apply merges from a base64 .xlsx (sourceProductNo → targetProductNo)' })
  async importXlsx(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const { file } = parseWith(ImportBody, body);
    return apiData(await this.merge.importXlsx(ctx, file));
  }
}
