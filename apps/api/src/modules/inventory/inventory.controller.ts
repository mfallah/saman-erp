/**
 * Inventory HTTP surface (`API.md` §4.4). Balance/ledger reads are cursor lists;
 * all business rules live in `InventoryService`.
 */
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { buildCursorMeta } from '@saman/shared';
import type { FastifyReply } from 'fastify';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { RequireStepUp } from '../../common/decorators/require-step-up.decorator';
import { ScopeCheck } from '../../common/decorators/scope-check.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { parseIfMatch } from './inventory.pg-support';
import { InventoryService } from './inventory.service';
import { AdjustmentListQuery, ApproveBody, AvailabilityQuery, BalanceListQuery, ConsumeReservationBody, CountListQuery, CountScanBody, CreateAdjustmentBody, CreateCountBody, CreateReservationBody, CreateTransferBody, IdParam, IntegrityCheckQuery, LedgerListQuery, ReceiveTransferBody, ReleaseReservationBody, ReservationListQuery, TransferCancelBody, TransferListQuery, ValuationLayersQuery, ValuationQuery, VoidBody, parseWith } from './dto/inventory.dto';

function cursorList(items: readonly unknown[], limit: number, hasMore: boolean) {
  return apiData(items, {
    pagination: buildCursorMeta(limit, { hasMore }),
  });
}

function offset(data: readonly unknown[], total: number, page: number, perPage: number) {
  return apiData(data, {
    pagination: { mode: 'offset', page, perPage, totalPages: Math.ceil(total / perPage), total },
    total,
  });
}

function versioned(reply: FastifyReply, data: Record<string, unknown>): Record<string, unknown> {
  const version = data['version'];
  if (typeof version === 'number') reply.header('ETag', `"${version}"`);
  return data;
}

@ApiTags('inventory')
@ApiBearerAuth()
@ScopeCheck('warehouseId')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  // --------------------------------------------------------------- balances

  @Get('balances')
  @Permissions('inventory.balance.read')
  async listBalances(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(BalanceListQuery, query);
    const items = await this.service.listBalances(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Get('balances/:id')
  @Permissions('inventory.balance.read')
  async getBalance(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getBalance(ctx, id));
  }

  @Get('availability')
  @Permissions('inventory.balance.read')
  @ApiOperation({ summary: 'Bulk availability for allocation/channel push' })
  async availability(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.availability(ctx, parseWith(AvailabilityQuery, query)));
  }

  @Get('ledger')
  @Permissions('inventory.ledger.read')
  async listLedger(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(LedgerListQuery, query);
    const items = await this.service.listLedger(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Get('ledger/:id')
  @Permissions('inventory.ledger.read')
  async getLedgerEntry(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getLedgerEntry(ctx, id));
  }

  // ------------------------------------------------------------- reservations

  @Get('reservations')
  @Permissions('inventory.reserve.read')
  async listReservations(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(ReservationListQuery, query);
    const items = await this.service.listReservations(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Post('reservations')
  @Permissions('inventory.reserve')
  @Idempotent({ required: true })
  @Audited('inventory.reservation.create')
  async createReservation(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createReservation(ctx, parseWith(CreateReservationBody, body)));
  }

  @Get('reservations/:id')
  @Permissions('inventory.reserve.read')
  async getReservation(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getReservation(ctx, id));
  }

  @Post('reservations/:id/release')
  @HttpCode(200)
  @Permissions('inventory.reserve')
  @Audited('inventory.reservation.release')
  async releaseReservation(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    const input = parseWith(ReleaseReservationBody, body);
    return apiData(await this.service.releaseReservation(ctx, id, input.reason));
  }

  @Post('reservations/:id/consume')
  @HttpCode(200)
  @Permissions('inventory.reserve')
  @Audited('inventory.reservation.consume')
  async consumeReservation(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.consumeReservation(ctx, id, parseWith(ConsumeReservationBody, body)));
  }

  // -------------------------------------------------------------- adjustments

  @Get('adjustments')
  @Permissions('inventory.adjust.read')
  async listAdjustments(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(AdjustmentListQuery, query);
    const result = await this.service.listAdjustments(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post('adjustments')
  @Permissions('inventory.adjust')
  @Idempotent({ required: true })
  @Audited('inventory.adjustment.create')
  async createAdjustment(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createAdjustment(ctx, parseWith(CreateAdjustmentBody, body)));
  }

  @Get('adjustments/:id')
  @Permissions('inventory.adjust.read')
  async getAdjustment(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getAdjustment(ctx, id));
  }

  @Post('adjustments/:id/submit')
  @HttpCode(200)
  @Permissions('inventory.adjust')
  @Audited('inventory.adjustment.submit')
  async submitAdjustment(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.submitAdjustment(ctx, id));
  }

  @RequireStepUp('inventory.adjustment.approve')
  @Post('adjustments/:id/approve')
  @HttpCode(200)
  @Permissions('inventory.adjust.approve')
  @Audited('inventory.adjustment.approve')
  async approveAdjustment(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.approveAdjustment(ctx, id, parseWith(ApproveBody, body)));
  }

  @RequireStepUp('inventory.adjustment.post')
  @Post('adjustments/:id/post')
  @HttpCode(200)
  @Permissions('inventory.adjust.post')
  @Audited('inventory.adjustment.post')
  async postAdjustment(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.postAdjustment(ctx, id));
  }

  @RequireStepUp('inventory.adjustment.void')
  @Post('adjustments/:id/void')
  @HttpCode(200)
  @Permissions('inventory.adjust.post')
  @Audited('inventory.adjustment.void')
  async voidAdjustment(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.voidAdjustment(ctx, id, parseWith(VoidBody, body).reason));
  }

  // ----------------------------------------------------------------- transfers

  @Get('transfers')
  @Permissions('inventory.transfer.read')
  async listTransfers(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(TransferListQuery, query);
    const items = await this.service.listTransfers(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Post('transfers')
  @Permissions('inventory.transfer')
  @Idempotent({ required: true })
  @Audited('inventory.transfer.create')
  async createTransfer(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createTransfer(ctx, parseWith(CreateTransferBody, body)));
  }

  @Get('transfers/:id')
  @Permissions('inventory.transfer.read')
  async getTransfer(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getTransfer(ctx, id));
  }

  @Post('transfers/:id/submit')
  @HttpCode(200)
  @Permissions('inventory.transfer')
  @Audited('inventory.transfer.submit')
  async submitTransfer(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.submitTransfer(ctx, id));
  }

  @Post('transfers/:id/approve')
  @HttpCode(200)
  @Permissions('inventory.transfer.approve')
  @Audited('inventory.transfer.approve')
  async approveTransfer(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.approveTransfer(ctx, id));
  }

  @Post('transfers/:id/dispatch')
  @HttpCode(200)
  @Permissions('inventory.transfer')
  @Audited('inventory.transfer.dispatch')
  async dispatchTransfer(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.dispatchTransfer(ctx, id));
  }

  @Post('transfers/:id/receive')
  @HttpCode(200)
  @Permissions('inventory.transfer')
  @Audited('inventory.transfer.receive')
  async receiveTransfer(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.receiveTransfer(ctx, id, parseWith(ReceiveTransferBody, body)));
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @Permissions('inventory.transfer')
  @Audited('inventory.transfer.cancel')
  async cancelTransfer(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.cancelTransfer(ctx, id, parseWith(TransferCancelBody, body).reason));
  }

  // -------------------------------------------------------------------- counts

  @Get('counts')
  @Permissions('inventory.count.read')
  async listCounts(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(CountListQuery, query);
    const items = await this.service.listCounts(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Post('counts')
  @Permissions('inventory.count')
  @Idempotent({ required: true })
  @Audited('inventory.count.create')
  async createCount(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createCount(ctx, parseWith(CreateCountBody, body)));
  }

  @Get('counts/:id')
  @Permissions('inventory.count.read')
  async getCount(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getCount(ctx, id));
  }

  @Post('counts/:id/start')
  @HttpCode(200)
  @Permissions('inventory.count')
  @Audited('inventory.count.start')
  async startCount(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.startCount(ctx, id));
  }

  @Post('counts/:id/scans')
  @HttpCode(200)
  @Permissions('inventory.count')
  @Audited('inventory.count.scan')
  async recordScan(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.recordCountScan(ctx, id, parseWith(CountScanBody, body)));
  }

  @Post('counts/:id/submit')
  @HttpCode(200)
  @Permissions('inventory.count')
  @Audited('inventory.count.submit')
  async submitCount(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.submitCount(ctx, id));
  }

  @Post('counts/:id/approve')
  @HttpCode(200)
  @Permissions('inventory.count.approve')
  @Audited('inventory.count.approve')
  async approveCount(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.approveCount(ctx, id));
  }

  @Post('counts/:id/post')
  @HttpCode(200)
  @Permissions('inventory.count.post')
  @Audited('inventory.count.post')
  async postCount(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.postCount(ctx, id));
  }

  @Get('counts/:id/variance')
  @Permissions('inventory.count.read')
  async countVariance(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.countVariance(ctx, id));
  }

  // ----------------------------------------------------------------- valuation

  @Get('valuation')
  @Permissions('inventory.valuation.read')
  async valuation(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.currentValuation(ctx, parseWith(ValuationQuery, query)));
  }

  @Get('valuation/layers')
  @Permissions('inventory.valuation.read')
  async valuationLayers(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(ValuationLayersQuery, query);
    const items = await this.service.listValuationLayers(ctx, q);
    return cursorList(items, q.limit, items.length === q.limit);
  }

  @Post('valuation/run')
  @HttpCode(202)
  @Permissions('inventory.valuation.read')
  @Audited('inventory.valuation.run')
  async runValuation(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const input = parseWith(ValuationQuery, body);
    return apiData(await this.service.runValuation(ctx, { warehouseId: input.warehouseId, valuationDate: input.asOf }));
  }

  @Get('valuation/runs/:id')
  @Permissions('inventory.valuation.read')
  async valuationRun(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getValuationRun(ctx, id));
  }

  @Get('integrity-check')
  @Permissions('inventory.balance.read')
  async integrityCheck(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.integrityCheck(ctx, parseWith(IntegrityCheckQuery, query)));
  }
}
