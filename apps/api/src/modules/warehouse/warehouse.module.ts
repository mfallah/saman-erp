/**
 * Warehouse Nest module (`API.md` §4.5). Depends on catalog/inventory/sales
 * public services only — never their repositories/tables.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ChannelsModule } from '../channels/channels.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesModule } from '../sales/sales.module';
import { PickAssignmentService } from './pick-assignment.service';
import { PickBackfillScheduler } from './pick-backfill.scheduler';
import { WarehouseRepository } from './warehouse.repository';
import { WarehouseTreeController } from './warehouse-tree.controller';
import { WarehouseService } from './warehouse.service';
import {
  LocationsController,
  PackTasksController,
  PickTasksController,
  WarehousePickTasksController,
  PickWavesController,
  PutawayController,
  WarehousesController,
} from './warehouse.controller';

@Module({
  imports: [CatalogModule, InventoryModule, SalesModule, ChannelsModule],
  controllers: [WarehouseTreeController, WarehousesController, LocationsController, PutawayController, PickWavesController, PickTasksController, WarehousePickTasksController, PackTasksController],
  providers: [WarehouseRepository, WarehouseService, PickAssignmentService, PickBackfillScheduler],
  exports: [WarehouseService, PickAssignmentService],
})
export class WarehouseModule {}
