import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { StepUpGuard } from './common/guards/step-up.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { PlatformModule } from './common/platform.module';

/* platform surface */
import { HealthModule } from './modules/health/health.module';
import { HttpMetricsInterceptor } from './modules/metrics/http-metrics.interceptor';
import { MetricsModule } from './modules/metrics/metrics.module';

/* identity & access */
import { IdentityGuard } from './modules/identity/identity.guard';
import { IdentityModule } from './modules/identity/identity.module';

/* commerce spine (catalog → inventory → sales → warehouse) */
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';

/* finance */
import { AccountingModule } from './modules/accounting/accounting.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { PartnersModule } from './modules/partners/partners.module';
import { ReportingModule } from './modules/reporting/reporting.module';

/* channels & integrations */
import { ChannelsModule } from './modules/channels/channels.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AutomationModule } from './modules/automation/automation.module';

/**
 * Composition root.
 *
 * Business modules are deliberately independent: they talk to each other only
 * through exported services and the platform contracts (`common/contracts.ts`),
 * never through each other's repositories (ARCHITECTURE §4.1). The global
 * default-deny permission guard + error envelope + request tracing are wired
 * here, so every route is authenticated unless explicitly `@Public()`.
 *
 * Modules intentionally NOT built in v1.0 (documented in docs/09-roadmap):
 * procurement, pricing, fulfillment, HR/payroll, e-invoicing.
 */
@Module({
  imports: [
    /* platform */
    AppConfigModule,
    LoggingModule,
    PlatformModule,
    HealthModule,
    MetricsModule,

    /* identity & access */
    IdentityModule,

    /* commerce spine (dependency direction: catalog → inventory → sales → warehouse) */
    CatalogModule,
    InventoryModule,
    SalesModule,
    WarehouseModule,

    /* finance */
    AccountingModule,
    TreasuryModule,
    PartnersModule,
    ReportingModule,

    /* channels & integrations */
    ChannelsModule,
    IntegrationsModule,
    NotificationsModule,
    AutomationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Authentication first: verifies the access token, loads the session/permissions
    // and publishes the tenant context; PermissionsGuard is the second fail-closed layer.
    { provide: APP_GUARD, useClass: IdentityGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Step-up third: only routes decorated with @RequireStepUp are affected.
    { provide: APP_GUARD, useClass: StepUpGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
