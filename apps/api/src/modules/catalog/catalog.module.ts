/**
 * Catalog Nest module (`ARCHITECTURE.md` §4). Composition only: the controller
 * classes, services and repositories of the catalog bounded context.
 *
 * It exports the cross-module read services (`CatalogLookupService`, `CatalogService`
 * product lookups) so inventory/warehouse/procurement/sales/fulfillment/pricing
 * depend on a public service instead of catalog tables (`§4.1` rule 2).
 */
import { Module } from '@nestjs/common';

import { ChannelsModule } from '../channels/channels.module';
import { CatalogRepository } from './catalog.repository';
import { ProductRepository } from './product.repository';
import { ProductMergeController } from './product-merge.controller';
import { ProductMergeService } from './product-merge.service';
import { CatalogService } from './catalog.service';
import { CatalogLookupService, ProductService } from './product.service';
import {
  AttributeValuesController,
  AttributesController,
  BarcodesController,
  BrandsController,
  CategoriesController,
  ProductsController,
  UnitsController,
  VariantsController,
} from './catalog.controller';

@Module({
  // The merge workbench pushes price/stock to mapped channel accounts after a
  // merge; `ChannelSyncService` is the channels module's public seam.
  imports: [ChannelsModule],
  controllers: [
    // Before ProductsController so the static `products/merge/candidates`
    // route settles ahead of the `products/:id` route in registration order.
    ProductMergeController,
    CategoriesController,
    BrandsController,
    ProductsController,
    VariantsController,
    BarcodesController,
    AttributesController,
    AttributeValuesController,
    UnitsController,
  ],
  providers: [
    CatalogRepository,
    ProductRepository,
    CatalogService,
    ProductService,
    CatalogLookupService,
    ProductMergeService,
  ],
  exports: [CatalogService, ProductService, CatalogLookupService],
})
export class CatalogModule {}
