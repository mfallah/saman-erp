/**
 * Inventory Nest module (`ARCHITECTURE.md` §4). Imports `CatalogModule` for the
 * public `CatalogLookupService` — inventory never reads catalog tables directly.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService],
  exports: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
