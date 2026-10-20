/**
 * Warehouse Nest module (`API.md` §4.5). Depends on catalog/inventory/sales
 * public services only — never their repositories/tables.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesModule } from '../sales/sales.module';
import { WarehouseRepository } from './warehouse.repository';
import { WarehouseService } from './warehouse.service';
import {
  LocationsController,
  PickTasksController,
  PickWavesController,
  PutawayController,
  WarehousesController,
} from './warehouse.controller';

@Module({
  imports: [CatalogModule, InventoryModule, SalesModule],
  controllers: [WarehousesController, LocationsController, PutawayController, PickWavesController, PickTasksController],
  providers: [WarehouseRepository, WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
