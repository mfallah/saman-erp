/**
 * Sales Nest module (`API.md` §4.7). Imports catalog (variant snapshots) and
 * inventory (reservation/issue public service) — never their tables.
 */
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';
import {
  CustomersController,
  InvoicesController,
  RefundsController,
  ReturnsController,
  SalesOrdersController,
} from './sales.controller';

@Module({
  imports: [CatalogModule, InventoryModule],
  controllers: [CustomersController, SalesOrdersController, InvoicesController, ReturnsController, RefundsController],
  providers: [SalesRepository, SalesService],
  exports: [SalesService],
})
export class SalesModule {}
