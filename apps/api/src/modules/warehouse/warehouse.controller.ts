/**
 * Warehouse HTTP surface (`API.md` §4.5): warehouses, location tree, putaway
 * suggestions, pick waves, pick tasks with two-stage scan verification.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { ScopeCheck, ScopeResource } from '../../common/decorators/scope-check.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { WarehouseService } from './warehouse.service';
import { AssignTaskBody, BulkCreateLocationsBody, CreatePickWaveBody, CreateWarehouseBody, IdParam, LocationListQuery, LocationLookupQuery, LocationNodeInput, MoveLocationBody, PackTaskCompleteBody, PickScanBody, PickTaskAssignBody, PickTaskListQuery, PutawaySuggestionQuery, ReleaseWaveBody, ShortPickBody, StationPickCompleteBody, TaskCancelBody, UpdateLocationBody, UpdateWarehouseBody, WarehouseListQuery, WaveCancelBody, WaveListQuery, parseWith } from './dto/warehouse.dto';

function offset(data: readonly unknown[], total: number, page: number, perPage: number) {
  return apiData(data, {
    pagination: { mode: 'offset', page, perPage, totalPages: Math.ceil(total / perPage), total },
    total,
  });
}

function cursor(data: readonly unknown[], limit: number) {
  return apiData(data, { pagination: { mode: 'cursor', limit, hasMore: data.length === limit } });
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('warehouse')
@ScopeCheck('branchId')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  @Permissions('warehouse.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(WarehouseListQuery, query);
    const items = await this.service.listWarehouses(ctx, q);
    return offset(items, items.length, q.page, q.perPage);
  }

  @Post()
  @Permissions('warehouse.create')
  @Idempotent({ required: true })
  @Audited('warehouse.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createWarehouse(ctx, parseWith(CreateWarehouseBody, body)));
  }

  @Get(':id')
  @Permissions('warehouse.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getWarehouse(ctx, id));
  }

  @Patch(':id')
  @Permissions('warehouse.update')
  @Audited('warehouse.update')
  async update(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.updateWarehouse(ctx, id, parseWith(UpdateWarehouseBody, body)));
  }

  @Delete(':id')
  @Permissions('warehouse.delete')
  @HttpCode(204)
  @Audited('warehouse.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteWarehouse(ctx, id);
  }

  @Get(':id/tree')
  @Permissions('warehouse.location.read')
  async tree(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.locationTree(ctx, id));
  }

  @Get(':id/capacity')
  @Permissions('warehouse.read')
  async capacity(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.capacity(ctx, id));
  }

  @Get(':id/locations')
  @Permissions('warehouse.location.read')
  async locations(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(LocationListQuery, query);
    const items = await this.service.listWarehouseLocations(ctx, id, q);
    return cursor(items, q.limit);
  }

  @Post(':id/locations')
  @Permissions('warehouse.location.create')
  @Idempotent({ required: true })
  @Audited('warehouse.location.create')
  async createLocation(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.createLocationNode(ctx, id, parseWith(LocationNodeInput, body)));
  }

  @Post(':id/locations/bulk')
  @HttpCode(200)
  @Permissions('warehouse.location.create')
  @Audited('warehouse.location.bulk_create')
  async bulkCreate(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.bulkCreateLocations(ctx, id, parseWith(BulkCreateLocationsBody, body)));
  }
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('location')
@Controller('locations')
export class LocationsController {
  constructor(private readonly service: WarehouseService) {}

  @Get('lookup')
  @Permissions('warehouse.location.read')
  async lookup(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(LocationLookupQuery, query);
    return apiData(await this.service.lookupLocation(ctx, q.code));
  }

  @Get(':id')
  @Permissions('warehouse.location.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getLocation(ctx, id));
  }

  @Patch(':id')
  @Permissions('warehouse.location.update')
  @Audited('warehouse.location.update')
  async update(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.updateLocation(ctx, id, parseWith(UpdateLocationBody, body)));
  }

  @Delete(':id')
  @Permissions('warehouse.location.delete')
  @HttpCode(204)
  @Audited('warehouse.location.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteLocation(ctx, id);
  }

  @Post(':id/move')
  @HttpCode(200)
  @Permissions('warehouse.location.update')
  @Audited('warehouse.location.move')
  async move(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    parseWith(MoveLocationBody, body);
    return apiData(await this.service.getLocation(ctx, id));
  }

  @Get(':id/contents')
  @Permissions('warehouse.location.read')
  async contents(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.locationContents(ctx, id));
  }
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeCheck('warehouseId')
@Controller('putaway')
export class PutawayController {
  constructor(private readonly service: WarehouseService) {}

  @Get('suggestions')
  @Permissions('warehouse.putaway.read')
  async suggestions(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.putawaySuggestions(ctx, parseWith(PutawaySuggestionQuery, query)));
  }
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('pick_wave')
@ScopeCheck('warehouseId')
@Controller('pick-waves')
export class PickWavesController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  @Permissions('warehouse.wave.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(WaveListQuery, query);
    const items = await this.service.listWaves(ctx, q);
    return cursor(items, q.limit);
  }

  @Post()
  @Permissions('warehouse.wave')
  @Idempotent({ required: true })
  @Audited('warehouse.wave.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createPickWave(ctx, parseWith(CreatePickWaveBody, body)));
  }

  @Get(':id')
  @Permissions('warehouse.wave.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getWave(ctx, id));
  }

  @Post(':id/release')
  @HttpCode(200)
  @Permissions('warehouse.wave')
  @Audited('warehouse.wave.release')
  async release(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.releaseWave(ctx, id, parseWith(ReleaseWaveBody, body)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Permissions('warehouse.wave')
  @Audited('warehouse.wave.cancel')
  async cancel(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.cancelWave(ctx, id, parseWith(WaveCancelBody, body).reason));
  }
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('pick_task')
@Controller('pick-tasks')
export class PickTasksController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  @Permissions('warehouse.pick.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(PickTaskListQuery, query);
    const items = await this.service.listPickTasks(ctx, q);
    return cursor(items, q.limit);
  }

  @Get(':id')
  @Permissions('warehouse.pick.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getPickTask(ctx, id));
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.assign')
  async assign(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.assignPickTask(ctx, id, parseWith(AssignTaskBody, body)));
  }

  @Post(':id/start')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.start')
  async start(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.startPickTask(ctx, id));
  }

  @Post(':id/scans')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.scan')
  async scan(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.scanPickTask(ctx, id, parseWith(PickScanBody, body)));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.complete')
  async complete(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.completePickTask(ctx, id));
  }

  @Post(':id/short')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.short')
  async short(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.shortPickTask(ctx, id, parseWith(ShortPickBody, body)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.cancel')
  async cancel(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.cancelPickTask(ctx, id, parseWith(TaskCancelBody, body).reason));
  }
}

/**
 * Picker-facing feed and manual reassignment. Mounted under `/warehouse` because
 * these are the routes the picking UI calls; execution stays on `/pick-tasks`.
 * `warehouse.pick` is the registered execute/assign key (there is no
 * `warehouse.pick.assign` in the permission registry).
 */
@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('pick_task')
@Controller('warehouse/pick-tasks')
export class WarehousePickTasksController {
  constructor(private readonly service: WarehouseService) {}

  @Get('mine')
  @Permissions('warehouse.pick.read')
  async mine(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.service.listMyPickTasks(ctx, 100));
  }

  /** Board of all open tasks, grouped by order, for the picking station. */
  @Get('board')
  @Permissions('warehouse.pick.read')
  async board(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.service.pickTaskBoard(ctx, 200));
  }

  /** Creates missing pick tasks for orders whose lines already exist. */
  @Post('backfill')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.backfill')
  async backfill(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.service.backfillPickTasks(ctx, 50));
  }

  @Post(':id/start')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.start')
  async start(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.startPickTask(ctx, id));
  }

  /** Completion with the operator's confirmed quantity (and optional scan). */
  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.complete')
  async complete(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.completeStationPickTask(ctx, id, parseWith(StationPickCompleteBody, body ?? {})));
  }

  @Patch(':id/assign')
  @Permissions('warehouse.pick')
  @Audited('warehouse.pick.assign')
  async assign(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.reassignPickTask(ctx, id, parseWith(PickTaskAssignBody, body)));
  }
}

/**
 * Packing station (`warehouse/pack-tasks`). Tasks are created by the picking
 * station once an order is fully picked; completion marks the order
 * `ready_to_ship` and performs a best-effort channel notification.
 */
@ApiTags('warehouse')
@ApiBearerAuth()
@ScopeResource('pack_task')
@Controller('warehouse/pack-tasks')
export class PackTasksController {
  constructor(private readonly service: WarehouseService) {}

  @Get('board')
  @Permissions('warehouse.pack.read')
  async board(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.service.packTaskBoard(ctx, 200));
  }

  @Post(':id/start')
  @HttpCode(200)
  @Permissions('warehouse.pack')
  @Audited('warehouse.pack.start')
  async start(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.startPackTask(ctx, id));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('warehouse.pack')
  @Audited('warehouse.pack.complete')
  async complete(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.completePackTask(ctx, id, parseWith(PackTaskCompleteBody, body ?? {})));
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Permissions('warehouse.pack')
  @Audited('warehouse.pack.assign')
  async assign(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.assignPackStationTask(ctx, id, parseWith(PickTaskAssignBody, body)));
  }
}
