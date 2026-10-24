/**
 * Purchasing HTTP surface (`TASK A`): supplier lookup/creation and goods receipts.
 *
 * All business rules live in `PurchasingService`; this controller only parses,
 * authorizes and shapes the envelope.
 *
 * Permissions are the registered keys from `permissions.generated.ts`:
 * - reads: `purchase.order.read` (granted to admin/warehouse_manager),
 * - goods receipt write: `goods.receipt.create` — the document being posted is a
 *   GRN, and this is the key the warehouse_manager role actually holds (it has
 *   `purchase.order.read` but not `purchase.order.create`),
 * - supplier master: `purchase.order.create` (procurement master data).
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { TenantContext } from '../../common/contracts';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { ScopeCheck } from '../../common/decorators/scope-check.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import {
  CreateReceiptBody,
  CreateSupplierBody,
  IdParam,
  ReceiptListQuery,
  SupplierListQuery,
  parseWith,
} from './dto/purchasing.dto';
import { PurchasingService } from './purchasing.service';

function offset(data: readonly unknown[], total: number, page: number, perPage: number) {
  return apiData(data, {
    pagination: { mode: 'offset', page, perPage, totalPages: Math.ceil(total / perPage), total },
    total,
  });
}

@ApiTags('purchasing')
@ApiBearerAuth()
@ScopeCheck('warehouseId')
@Controller('purchasing')
export class PurchasingController {
  constructor(private readonly service: PurchasingService) {}

  // ----------------------------------------------------------------- suppliers

  @Get('suppliers')
  @Permissions('purchase.order.read')
  @ApiOperation({ summary: 'Supplier search for the receipt form' })
  async listSuppliers(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(SupplierListQuery, query);
    const items = await this.service.listSuppliers(ctx, q);
    return apiData(items, { total: items.length });
  }

  @Post('suppliers')
  @Permissions('purchase.order.create')
  @Idempotent()
  @Audited('purchase.supplier.create')
  @ApiOperation({ summary: 'Create a supplier master' })
  async createSupplier(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createSupplier(ctx, parseWith(CreateSupplierBody, body)));
  }

  // ------------------------------------------------------------------ receipts

  @Get('receipts')
  @Permissions('purchase.order.read')
  @ApiOperation({ summary: 'Goods receipts with supplier/warehouse names and totals' })
  async listReceipts(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(ReceiptListQuery, query);
    const result = await this.service.listReceipts(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post('receipts')
  @Permissions('goods.receipt.create')
  @Idempotent()
  @Audited('purchase.receipt.create')
  @ApiOperation({ summary: 'Post a goods receipt (order + GRN + inbound stock)' })
  async createReceipt(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createReceipt(ctx, parseWith(CreateReceiptBody, body)));
  }


  @Post('receipts/:id/void')
  @Permissions('purchase.order.update')
  @ApiOperation({ summary: 'Void a posted receipt and reverse its stock' })
  @Audited('purchase.receipt.void')
  async voidReceipt(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.voidReceipt(ctx, id));
  }

  @Get('receipts/:id')
  @Permissions('purchase.order.read')
  @ApiOperation({ summary: 'One goods receipt with lines and serials' })
  async getReceipt(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getReceipt(ctx, id));
  }
}
