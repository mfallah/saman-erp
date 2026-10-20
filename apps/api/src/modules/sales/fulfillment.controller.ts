/**
 * Fulfillment HTTP surface: packing tasks, shipments, dispatch and delivery.
 * Thin controller over `FulfillmentService`.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import {
  CompletePackingBody,
  CreatePackingTaskBody,
  DeliverShipmentBody,
  DispatchShipmentBody,
  PackingScanBody,
  ShipmentListQuery,
  parseWith,
} from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';

@ApiTags('fulfillment')
@ApiBearerAuth()
@Controller('fulfillment')
export class FulfillmentController {
  constructor(private readonly service: FulfillmentService) {}

  @Post('packing-tasks')
  @Permissions('warehouse.pack')
  @Audited('fulfillment.packing_task.create')
  @ApiOperation({ summary: 'ایجاد تسک بسته‌بندی برای سفارش' })
  async createTask(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createPackingTask(ctx, parseWith(CreatePackingTaskBody, body)));
  }

  @Get('packing-tasks/:id')
  @Permissions('warehouse.pack.read')
  @ApiOperation({ summary: 'جزئیات تسک بسته‌بندی' })
  async getTask(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return apiData(await this.service.getPackingTask(ctx, id));
  }

  @Post('packing-tasks/:id/scans')
  @HttpCode(200)
  @Permissions('warehouse.pack')
  @Audited('fulfillment.packing_task.scan')
  @ApiOperation({ summary: 'اسکن بارکد در بسته‌بندی' })
  async scan(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return apiData(await this.service.scanPackingTask(ctx, id, parseWith(PackingScanBody, body)));
  }

  @Post('packing-tasks/:id/complete')
  @HttpCode(201)
  @Permissions('warehouse.pack')
  @Audited('fulfillment.packing_task.complete')
  @ApiOperation({ summary: 'پایان بسته‌بندی و ساخت محموله' })
  async complete(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return apiData(await this.service.completePacking(ctx, id, parseWith(CompletePackingBody, body)));
  }

  @Get('shipments')
  @Permissions('shipment.read')
  @ApiOperation({ summary: 'فهرست محموله‌ها' })
  async listShipments(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const dto = parseWith(ShipmentListQuery, query);
    const items = await this.service.listShipments(ctx, { status: dto.status ?? null, limit: dto.limit });
    return apiData(items, { pagination: { mode: 'offset', limit: dto.limit, count: items.length } });
  }

  @Get('shipments/:id')
  @Permissions('shipment.read')
  @ApiOperation({ summary: 'جزئیات محموله' })
  async getShipment(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return apiData(await this.service.getShipment(ctx, id));
  }

  @Post('shipments/:id/dispatch')
  @HttpCode(200)
  @Permissions('shipment.dispatch')
  @Audited('fulfillment.shipment.dispatch')
  @ApiOperation({ summary: 'ارسال محموله (خروج موجودی و ثبت بهای تمام‌شده)' })
  async dispatch(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return apiData(await this.service.dispatchShipment(ctx, id, parseWith(DispatchShipmentBody, body)));
  }

  @Post('shipments/:id/deliver')
  @HttpCode(200)
  @Permissions('shipment.update')
  @Audited('fulfillment.shipment.deliver')
  @ApiOperation({ summary: 'ثبت تحویل محموله' })
  async deliver(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    void parseWith(DeliverShipmentBody, body ?? {});
    return apiData(await this.service.deliverShipment(ctx, id));
  }
}
