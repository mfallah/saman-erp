/**
 * Stock workspace HTTP surface (`GET /inventory/stock`, `POST /inventory/stock/adjust`).
 * All business rules live in `InventoryStockService`; this controller only parses,
 * authorizes and shapes the offset-paginated envelope.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { TenantContext } from '../../common/contracts';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { ScopeCheck } from '../../common/decorators/scope-check.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { StockAdjustBody, StockHistoryQuery, StockListQuery, StockVariantParam, parseWith } from './dto/inventory.dto';
import { InventoryStockService } from './stock.service';

function offset(data: readonly unknown[], total: number, page: number, perPage: number) {
  return apiData(data, {
    pagination: { mode: 'offset', page, perPage, totalPages: Math.ceil(total / perPage), total },
    total,
  });
}

@ApiTags('inventory')
@ApiBearerAuth()
@ScopeCheck('warehouseId')
@Controller('inventory/stock')
export class InventoryStockController {
  constructor(private readonly service: InventoryStockService) {}

  @Get()
  @Permissions('inventory.balance.read')
  @ApiOperation({ summary: 'Variant stock with mapped channel accounts' })
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(StockListQuery, query);
    const result = await this.service.list(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post('adjust')
  @HttpCode(200)
  @Permissions('inventory.adjust')
  @Idempotent()
  @Audited('inventory.adjustment.quick_adjust')
  @ApiOperation({ summary: 'Apply a signed stock delta and queue channel pushes' })
  async adjust(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.adjust(ctx, parseWith(StockAdjustBody, body)));
  }

  @Get(':variantId/history')
  @Permissions('inventory.ledger.read')
  @ApiOperation({ summary: 'Ledger history of one variant' })
  async history(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { variantId } = parseWith(StockVariantParam, params);
    const q = parseWith(StockHistoryQuery, query);
    const result = await this.service.history(ctx, variantId, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }
}
