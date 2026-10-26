/**
 * Warehouse Nest module (`API.md` §4.5). Depends on catalog/inventory/sales
 * public services only — never their repositories/tables.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesModule } from '../sales/sales.module';
import { PickAssignmentService } from './pick-assignment.service';
import { WarehouseRepository } from './warehouse.repository';
import { WarehouseService } from './warehouse.service';
import {
  LocationsController,
  PickTasksController,
  WarehousePickTasksController,
  PickWavesController,
  PutawayController,
  WarehousesController,
} from './warehouse.controller';

@Module({
  imports: [CatalogModule, InventoryModule, SalesModule],
  controllers: [WarehousesController, LocationsController, PutawayController, PickWavesController, PickTasksController, WarehousePickTasksController],
  providers: [WarehouseRepository, WarehouseService, PickAssignmentService],
  exports: [WarehouseService, PickAssignmentService],
})
export class WarehouseModule {}
