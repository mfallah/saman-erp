/**
 * Catalog HTTP surface (`API.md` §4.3). Routes, permission decorators, audit
 * metadata and Zod validation only — all rules live in the services.
 */
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { buildOffsetMeta } from '@saman/shared';
import type { FastifyReply } from 'fastify';

import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import type { TenantContext } from '../../common/contracts';
import { CatalogService } from './catalog.service';
import { ProductService } from './product.service';
import { parseIfMatch } from './pg-support';
import { IdParam, parseWith } from './dto/common';
import { BrandListQuery, BulkUpdateCategoriesBody, CategoryListQuery, CreateBrandBody, CreateCategoryBody, MoveCategoryBody, UpdateBrandBody, UpdateCategoryBody } from './dto/category.dto';
import { AttributeListQuery, CreateAttributeBody, ReplaceAttributeValuesBody, ReplaceVariantAttributesBody, UpdateAttributeBody, UpdateAttributeValueBody } from './dto/attribute.dto';
import { ConversionIdParam, CreateConversionBody, CreateUnitBody, UnitDetailQuery, UnitListQuery, UpdateUnitBody } from './dto/unit.dto';
import { ArchiveProductBody, AttachMediaBody, BarcodeIdParam, BarcodeLookupQuery, BulkUpdateProductsBody, CostHistoryQuery, CreateBarcodeBody, CreateProductBody, CreateVariantBody, LookupProductQuery, MediaIdParam, PriceHistoryQuery, ProductDetailQuery, ProductListQuery, PublishProductBody, ReplaceSupplierLinksBody, UpdateMediaBody, UpdateProductBody, UpdateVariantBody, VariantIdParam, VariantListQuery } from './dto/product.dto';

const offset = (data: readonly unknown[], total: number, page: number, perPage: number) =>
  apiData(data, { pagination: buildOffsetMeta(page, perPage, total), total });

function versioned(reply: FastifyReply, data: Record<string, unknown>): Record<string, unknown> {
  const version = data['version'];
  if (typeof version === 'number') reply.header('ETag', `"${version}"`);
  return data;
}

function includeList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @Permissions('category.read')
  @ApiOperation({ summary: 'Category list or full tree' })
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(CategoryListQuery, query);
    const result = await this.service.listCategories(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('category.create')
  @Idempotent({ required: true })
  @Audited('category.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createCategory(ctx, parseWith(CreateCategoryBody, body)));
  }

  @Post('bulk-update')
  @Permissions('category.update')
  @HttpCode(200)
  @Audited('category.bulk_update')
  async bulkUpdate(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.bulkUpdateCategories(ctx, parseWith(BulkUpdateCategoriesBody, body)));
  }

  @Get(':id')
  @Permissions('category.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getCategory(ctx, id));
  }

  @Patch(':id')
  @Permissions('category.update')
  @Audited('category.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateCategory(ctx, id, parseWith(UpdateCategoryBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('category.delete')
  @HttpCode(204)
  @Audited('category.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteCategory(ctx, id);
  }

  @Post(':id/move')
  @HttpCode(200)
  @Permissions('category.update')
  @Audited('category.move')
  async move(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.moveCategory(ctx, id, parseWith(MoveCategoryBody, body)));
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('brands')
export class BrandsController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @Permissions('brand.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(BrandListQuery, query);
    const result = await this.service.listBrands(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('brand.create')
  @Idempotent({ required: true })
  @Audited('brand.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createBrand(ctx, parseWith(CreateBrandBody, body)));
  }

  @Get(':id')
  @Permissions('brand.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getBrand(ctx, id));
  }

  @Patch(':id')
  @Permissions('brand.update')
  @Audited('brand.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateBrand(ctx, id, parseWith(UpdateBrandBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('brand.delete')
  @HttpCode(204)
  @Audited('brand.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteBrand(ctx, id);
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductService) {}

  @Get()
  @Permissions('product.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(ProductListQuery, query);
    const result = await this.service.listProducts(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('product.create')
  @Idempotent({ required: true })
  @Audited('product.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createProduct(ctx, parseWith(CreateProductBody, body)));
  }

  @Get('lookup')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Scanner lookup by barcode/SKU' })
  async lookup(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.lookupProduct(ctx, parseWith(LookupProductQuery, query)));
  }

  @Post('bulk-update')
  @Permissions('product.update')
  @HttpCode(200)
  @Audited('product.bulk_update')
  async bulkUpdate(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.bulkUpdateProducts(ctx, parseWith(BulkUpdateProductsBody, body)));
  }

  @Get(':id')
  @Permissions('product.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(ProductDetailQuery, query);
    return apiData(await this.service.getProduct(ctx, id, includeList(q.include)));
  }

  @Patch(':id')
  @Permissions('product.update')
  @Audited('product.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateProduct(ctx, id, parseWith(UpdateProductBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('product.delete')
  @HttpCode(204)
  @Audited('product.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteProduct(ctx, id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.publish')
  async publish(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.publishProduct(ctx, id, parseWith(PublishProductBody, body)));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.archive')
  async archive(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.archiveProduct(ctx, id, parseWith(ArchiveProductBody, body)));
  }

  @Get(':id/variants')
  @Permissions('variant.read')
  async variants(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(VariantListQuery, query);
    const result = await this.service.listVariants(ctx, { ...q, productId: id });
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post(':id/variants')
  @Permissions('variant.create')
  @Idempotent({ required: true })
  @Audited('variant.create')
  async createVariant(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.createVariant(ctx, id, parseWith(CreateVariantBody, body)));
  }

  @Patch(':id/variants/:variantId')
  @Permissions('variant.update')
  @Audited('variant.update')
  async updateVariant(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id, variantId } = parseWith(VariantIdParam, params);
    const data = await this.service.updateVariant(
      ctx,
      variantId,
      parseWith(UpdateVariantBody, body),
      parseIfMatch(ifMatch),
      id,
    );
    return apiData(versioned(reply, data));
  }

  @Get(':id/price-history')
  @Permissions('product.read')
  async priceHistory(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(PriceHistoryQuery, query);
    return offset(await this.service.priceHistory(ctx, id, q), 0, q.page, q.perPage);
  }

  @Get(':id/cost-history')
  @Permissions('product.cost.read')
  async costHistory(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(CostHistoryQuery, query);
    return offset(await this.service.costHistory(ctx, id, q), 0, q.page, q.perPage);
  }

  @Get(':id/media')
  @Permissions('media.read')
  async media(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listProductMedia(ctx, id));
  }

  @Post(':id/media')
  @Permissions('media.create')
  @Idempotent({ required: true })
  @Audited('media.attach')
  async attachMedia(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.attachMedia(ctx, id, parseWith(AttachMediaBody, body)));
  }

  @Patch(':id/media/:mediaId')
  @Permissions('media.update')
  @Audited('media.update')
  async updateMedia(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id, mediaId } = parseWith(MediaIdParam, params);
    const data = await this.service.updateMedia(ctx, id, mediaId, parseWith(UpdateMediaBody, body));
    return apiData(versioned(reply, data));
  }

  @Delete(':id/media/:mediaId')
  @Permissions('media.delete')
  @HttpCode(204)
  @Audited('media.delete')
  async deleteMedia(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id, mediaId } = parseWith(MediaIdParam, params);
    await this.service.deleteMedia(ctx, id, mediaId);
  }

  @Get(':id/suppliers')
  @Permissions('supplier.read')
  async suppliers(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listProductSuppliers(ctx, id));
  }

  @Put(':id/suppliers')
  @Permissions('product.update')
  @Audited('product.suppliers_replace')
  async replaceSuppliers(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.replaceProductSuppliers(ctx, id, parseWith(ReplaceSupplierLinksBody, body)));
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('variants')
export class VariantsController {
  constructor(private readonly service: ProductService) {}

  @Get()
  @Permissions('variant.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(VariantListQuery, query);
    const result = await this.service.listVariants(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Get(':id')
  @Permissions('variant.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(ProductDetailQuery, query);
    return apiData(await this.service.getVariant(ctx, id, includeList(q.include)));
  }

  @Patch(':id')
  @Permissions('variant.update')
  @Audited('variant.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateVariant(ctx, id, parseWith(UpdateVariantBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('variant.delete')
  @HttpCode(204)
  @Audited('variant.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteVariant(ctx, id);
  }

  @Put(':id/attributes')
  @Permissions('variant.update')
  @Audited('variant.attributes_replace')
  async replaceAttributes(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.replaceVariantAttributes(ctx, id, parseWith(ReplaceVariantAttributesBody, body)));
  }

  @Get(':id/barcodes')
  @Permissions('barcode.read')
  async barcodes(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listVariantBarcodes(ctx, id));
  }

  @Post(':id/barcodes')
  @Permissions('barcode.create')
  @Idempotent({ required: true })
  @Audited('barcode.create')
  async addBarcode(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.addBarcode(ctx, id, parseWith(CreateBarcodeBody, body)));
  }

  @Delete(':id/barcodes/:barcodeId')
  @Permissions('barcode.delete')
  @HttpCode(204)
  @Audited('barcode.delete')
  async deleteBarcode(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id, barcodeId } = parseWith(BarcodeIdParam, params);
    await this.service.deleteBarcode(ctx, id, barcodeId);
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('barcodes')
export class BarcodesController {
  constructor(private readonly service: ProductService) {}

  @Get('lookup')
  @Permissions('barcode.read')
  async lookup(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.lookupBarcode(ctx, parseWith(BarcodeLookupQuery, query)));
  }

  @Get(':id')
  @Permissions('barcode.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getBarcode(ctx, id));
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('attributes')
export class AttributesController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @Permissions('attribute.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(AttributeListQuery, query);
    const result = await this.service.listAttributes(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('attribute.create')
  @Idempotent({ required: true })
  @Audited('attribute.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createAttribute(ctx, parseWith(CreateAttributeBody, body)));
  }

  @Get(':id')
  @Permissions('attribute.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getAttribute(ctx, id));
  }

  @Patch(':id')
  @Permissions('attribute.update')
  @Audited('attribute.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateAttribute(ctx, id, parseWith(UpdateAttributeBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('attribute.delete')
  @HttpCode(204)
  @Audited('attribute.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteAttribute(ctx, id);
  }

  @Get(':id/values')
  @Permissions('attribute.read')
  async values(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listAttributeValues(ctx, id));
  }

  @Put(':id/values')
  @Permissions('attribute.update')
  @Audited('attribute.values_replace')
  async replaceValues(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.replaceAttributeValues(ctx, id, parseWith(ReplaceAttributeValuesBody, body)));
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('attribute-values')
export class AttributeValuesController {
  constructor(private readonly service: CatalogService) {}

  @Patch(':id')
  @Permissions('attribute.update')
  @Audited('attribute_value.update')
  async update(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.updateAttributeValue(ctx, id, parseWith(UpdateAttributeValueBody, body)));
  }

  @Delete(':id')
  @Permissions('attribute.update')
  @HttpCode(204)
  @Audited('attribute_value.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteAttributeValue(ctx, id);
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('units')
export class UnitsController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @Permissions('unit.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(UnitListQuery, query);
    const result = await this.service.listUnits(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('unit.create')
  @Idempotent({ required: true })
  @Audited('unit.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createUnit(ctx, parseWith(CreateUnitBody, body)));
  }

  @Get(':id')
  @Permissions('unit.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    parseWith(UnitDetailQuery, query);
    return apiData(await this.service.getUnit(ctx, id));
  }

  @Patch(':id')
  @Permissions('unit.update')
  @Audited('unit.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateUnit(ctx, id, parseWith(UpdateUnitBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('unit.delete')
  @HttpCode(204)
  @Audited('unit.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteUnit(ctx, id);
  }

  @Get(':id/conversions')
  @Permissions('unit.read')
  async conversions(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listUnitConversions(ctx, id));
  }

  @Post(':id/conversions')
  @Permissions('unit.update')
  @Idempotent({ required: true })
  @Audited('unit.conversion_create')
  async addConversion(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.addUnitConversion(ctx, id, parseWith(CreateConversionBody, body)));
  }

  @Delete(':id/conversions/:conversionId')
  @Permissions('unit.update')
  @HttpCode(204)
  @Audited('unit.conversion_delete')
  async deleteConversion(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id, conversionId } = parseWith(ConversionIdParam, params);
    await this.service.deleteUnitConversion(ctx, id, conversionId);
  }
}
