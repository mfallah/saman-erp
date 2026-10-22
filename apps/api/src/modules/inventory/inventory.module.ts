/**
 * Inventory Nest module (`ARCHITECTURE.md` §4). Imports `CatalogModule` for the
 * public `CatalogLookupService` — inventory never reads catalog tables directly.
 * `ChannelsModule` is imported only for `ChannelSyncService`, which the stock
 * workspace uses to queue stock pushes after an adjustment commits.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ChannelsModule } from '../channels/channels.module';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryStockController } from './stock.controller';
import { InventoryStockService } from './stock.service';

@Module({
  imports: [CatalogModule, ChannelsModule],
  controllers: [InventoryController, InventoryStockController],
  providers: [InventoryRepository, InventoryService, InventoryStockService],
  exports: [InventoryService, InventoryRepository, InventoryStockService],
})
export class InventoryModule {}
