/**
 * Purchasing Nest module (`TASK A`).
 *
 * Imports the public surfaces it needs and nothing else:
 * - `CatalogModule` → `CatalogLookupService` (variant lookup, never catalog tables),
 * - `InventoryModule` → `InventoryService` (inbound ledger movements + placement),
 * - `ChannelsModule` → `ChannelSyncService` (post-commit `inventory_push` jobs).
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ChannelsModule } from '../channels/channels.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasingController } from './purchasing.controller';
import { ReceiptLabelsController } from './receipt-labels.controller';
import { PurchasingRepository } from './purchasing.repository';
import { PurchasingService } from './purchasing.service';

@Module({
  imports: [CatalogModule, ChannelsModule, InventoryModule],
  controllers: [PurchasingController, ReceiptLabelsController],
  providers: [PurchasingRepository, PurchasingService],
  exports: [PurchasingService],
})
export class PurchasingModule {}
