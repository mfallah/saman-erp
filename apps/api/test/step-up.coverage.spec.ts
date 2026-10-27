import 'reflect-metadata';

import { describe, it } from 'node:test';
import { Controller, Get, Post } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { expect } from './support/expect';
import { Permissions } from '../src/common/decorators/permissions.decorator';
import { RequireStepUp } from '../src/common/decorators/require-step-up.decorator';
import {
  StepUpCoverageService,
  type StepUpCoverageGap,
} from '../src/common/security/step-up-coverage.service';
import { isSensitivePermission } from '../src/common/security/step-up-policy';

import { JournalController } from '../src/modules/accounting/controllers/journal.controller';
import { AccountingOperationsController } from '../src/modules/accounting/controllers/operations.controller';
import { AccountingReportsController } from '../src/modules/accounting/controllers/reports.controller';
import { AccountingStructureController } from '../src/modules/accounting/controllers/structure.controller';
import {
  AttributesController,
  AttributeValuesController,
  BarcodesController,
  BrandsController,
  CategoriesController,
  ProductsController,
  UnitsController,
  VariantsController,
} from '../src/modules/catalog/catalog.controller';
import { ProductMergeController } from '../src/modules/catalog/product-merge.controller';
import { ChannelMappingsAdminController } from '../src/modules/channels/admin/channel-mappings.controller';
import { ChannelsAdminController } from '../src/modules/channels/admin/channels-admin.controller';
import {
  ChannelWebhookController,
  WebhookHealthController,
} from '../src/modules/channels/webhook/channel-webhook.controller';
import { FilesController } from '../src/modules/files/files.controller';
import { HealthController } from '../src/modules/health/health.controller';
import { AuthController } from '../src/modules/identity/auth.controller';
import {
  OrgAdminController,
  PermissionsAdminController,
  RolesAdminController,
  SystemAdminController,
  UsersAdminController,
} from '../src/modules/identity/admin.controllers';
import { InventoryController } from '../src/modules/inventory/inventory.controller';
import { InventoryStockController } from '../src/modules/inventory/stock.controller';
import { MetricsController } from '../src/modules/metrics/metrics.controller';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { PartnersController } from '../src/modules/partners/controllers/partners.controller';
import { PricingPolicyController } from '../src/modules/pricing/pricing-policy.controller';
import { PricingRulesController } from '../src/modules/pricing/pricing-rules.controller';
import { PricingController } from '../src/modules/pricing/pricing.controller';
import { PurchasingController } from '../src/modules/purchasing/purchasing.controller';
import { ReceiptLabelsController } from '../src/modules/purchasing/receipt-labels.controller';
import { ReportingController } from '../src/modules/reporting/controllers/reporting.controller';
import { FulfillmentController } from '../src/modules/sales/fulfillment.controller';
import {
  CustomersController,
  InvoicesController,
  RefundsController,
  ReturnsController,
  SalesOrdersController,
} from '../src/modules/sales/sales.controller';
import { TreasuryController } from '../src/modules/treasury/controllers/treasury.controller';
import {
  LocationsController,
  PackTasksController,
  PickTasksController,
  PickWavesController,
  PutawayController,
  WarehousePickTasksController,
  WarehousesController,
} from '../src/modules/warehouse/warehouse.controller';

const CONTROLLERS = [
  HealthController,
  AuthController,
  UsersAdminController,
  RolesAdminController,
  PermissionsAdminController,
  OrgAdminController,
  SystemAdminController,
  CategoriesController,
  BrandsController,
  ProductsController,
  VariantsController,
  BarcodesController,
  AttributesController,
  AttributeValuesController,
  UnitsController,
  ProductMergeController,
  InventoryController,
  InventoryStockController,
  SalesOrdersController,
  CustomersController,
  InvoicesController,
  ReturnsController,
  RefundsController,
  FulfillmentController,
  WarehousesController,
  LocationsController,
  PutawayController,
  PickWavesController,
  PickTasksController,
  WarehousePickTasksController,
  PackTasksController,
  JournalController,
  AccountingOperationsController,
  AccountingReportsController,
  AccountingStructureController,
  TreasuryController,
  PartnersController,
  PricingController,
  PricingRulesController,
  PricingPolicyController,
  PurchasingController,
  ReceiptLabelsController,
  ReportingController,
  ChannelsAdminController,
  ChannelMappingsAdminController,
  ChannelWebhookController,
  WebhookHealthController,
  FilesController,
  MetricsController,
  NotificationsController,
] as const;

/**
 * `DiscoveryService` stand-in over the real controller classes: `Object.create`
 * gives us the real prototype methods (and therefore their route/permission/
 * step-up metadata) without booting the DB-backed application.
 */
function serviceOver(controllers: readonly unknown[]): StepUpCoverageService {
  const discovery = {
    getControllers: () =>
      controllers.map((metatype) => ({
        instance: Object.create((metatype as { prototype: object }).prototype) as object,
        metatype,
      })),
  } as unknown as DiscoveryService;
  return new StepUpCoverageService(discovery, new MetadataScanner());
}

describe('step-up coverage self-check (TD-16)', () => {
  it('covers every sensitive @Permissions route with @RequireStepUp', () => {
    const gaps: StepUpCoverageGap[] = serviceOver(CONTROLLERS).collectGaps();
    const listing = gaps.map((gap) => `${gap.method} ${gap.path} [${gap.permissions.join(',')}]`);
    expect(listing).toEqual([]);
  });

  it('detects a sensitive route that lacks step-up metadata', () => {
    @Controller('synthetic')
    class SyntheticGapController {
      @Post('pay')
      @Permissions('payment.approve')
      pay(): void {}
    }

    @Controller('synthetic-covered')
    class SyntheticCoveredController {
      @RequireStepUp('payment.approve')
      @Post('pay')
      @Permissions('payment.approve')
      pay(): void {}

      @Get('read')
      @Permissions('payment.read')
      read(): void {}
    }

    const gaps = serviceOver([SyntheticGapController, SyntheticCoveredController]).collectGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.method).toBe('POST');
    expect(gaps[0]?.path).toBe('/synthetic/pay');
    expect(gaps[0]?.permissions).toEqual(['payment.approve']);
  });

  it('classifies the documented sensitive families and leaves reads alone', () => {
    for (const key of [
      'payment.approve',
      'cash.transaction.create',
      'customer.credit.update',
      'channel.credential.write',
      'accounting.journal.reverse',
      'role.assign',
      'user.reset_password',
      'inventory.adjust.post',
    ]) {
      expect(isSensitivePermission(key)).toBe(true);
    }
    for (const key of ['payment.read', 'accounting.journal.read', 'user.read', 'role.read']) {
      expect(isSensitivePermission(key)).toBe(false);
    }
  });
});
