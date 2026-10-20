/** Tax, valuation and closing-run HTTP surface (`API.md §4.11`). */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { ClosingService } from '../closing/closing.service';
import { TaxService } from '../tax/tax.service';
import { ValuationService } from '../valuation/valuation.service';
import {
  CloseSchema,
  CreateTaxDocumentSchema,
  CreateTaxRateSchema,
  StartValuationSchema,
  UpdateTaxRateSchema,
  ValuationFilterSchema,
  parseDto,
  toBigInt,
  toMoney,
} from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';

@ApiTags('accounting')
@Controller()
export class AccountingOperationsController {
  constructor(
    private readonly tax: TaxService,
    private readonly valuation: ValuationService,
    private readonly closing: ClosingService,
  ) {}

  /* ------------------------------- tax rates ------------------------------- */

  @Get('accounting/tax-rates')
  @RequirePermissions('accounting.tax.read')
  @ApiOperation({ summary: 'نرخ‌های مالیات' })
  async listTaxRates(
    @Tenant() ctx: TenantContext,
    @Query('active') active?: string,
    @Query('type') type?: string,
  ): Promise<{ data: readonly unknown[] }> {
    const rows = await this.tax.listRates(ctx, {
      ...(active === undefined ? {} : { active: active === 'true' }),
      ...(type === undefined ? {} : { type }),
    });
    return {
      data: rows.map((row) => ({
        id: row.id.toString(),
        code: row.code,
        nameFa: row.nameFa,
        type: row.taxType,
        rate: row.ratePercent,
        glAccountId: row.glAccountId.toString(),
        isRecoverable: row.isRecoverable,
        validFrom: row.effectiveFrom,
        validTo: row.effectiveTo,
        isDefault: row.isDefault,
        active: row.isActive,
      })),
    };
  }

  @Post('accounting/tax-rates')
  @RequirePermissions('accounting.tax.create')
  @ApiOperation({ summary: 'ایجاد نرخ مالیات' })
  async createTaxRate(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateTaxRateSchema, body);
    const rate = await this.tax.createRate(ctx, {
      code: dto.code,
      nameFa: dto.nameFa,
      taxType: dto.type,
      ratePercent: dto.rate,
      glAccountId: toBigInt(dto.glAccountId),
      effectiveFrom: dto.validFrom,
      ...(dto.validTo === undefined ? {} : { effectiveTo: dto.validTo }),
      ...(dto.isDefault === undefined ? {} : { isDefault: dto.isDefault }),
      ...(dto.isRecoverable === undefined ? {} : { isRecoverable: dto.isRecoverable }),
    });
    return { data: { id: rate.id.toString(), code: rate.code, rate: rate.ratePercent } };
  }

  @Patch('accounting/tax-rates/:id')
  @RequirePermissions('accounting.tax.update')
  @ApiOperation({ summary: 'ویرایش نرخ مالیات' })
  async updateTaxRate(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(UpdateTaxRateSchema, body);
    const rate = await this.tax.updateRate(ctx, toBigInt(id), {
      ...(dto.rate === undefined ? {} : { ratePercent: dto.rate }),
      ...(dto.validTo === undefined ? {} : { effectiveTo: dto.validTo }),
      ...(dto.active === undefined ? {} : { isActive: dto.active }),
    });
    return { data: { id: rate.id.toString(), rate: rate.ratePercent, active: rate.isActive } };
  }

  @Delete('accounting/tax-rates/:id')
  @RequirePermissions('accounting.tax.delete')
  @ApiOperation({ summary: 'حذف نرخ مالیات بدون استفاده' })
  async deleteTaxRate(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.tax.deleteRate(ctx, toBigInt(id));
  }

  /* ----------------------------- tax documents ----------------------------- */

  @Get('accounting/tax-documents')
  @RequirePermissions('accounting.document.read')
  @ApiOperation({ summary: 'اسناد مالیاتی' })
  async listTaxDocuments(
    @Tenant() ctx: TenantContext,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    const rows = await this.tax.listDocuments(ctx, {
      ...(type === undefined ? {} : { type }),
      ...(status === undefined ? {} : { status }),
    });
    return { data: rows };
  }

  @Post('accounting/tax-documents')
  @RequirePermissions('accounting.document.create')
  @ApiOperation({ summary: 'ایجاد پیش‌نویس سند مالیاتی' })
  async createTaxDocument(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateTaxDocumentSchema, body);
    const document = await this.tax.createDocument(ctx, {
      documentType: dto.type,
      ...(dto.documentKind === undefined ? {} : { documentKind: dto.documentKind }),
      taxableAmount: toMoney(dto.taxableAmount),
      ratePercent: dto.rate ?? '0',
      issueDate: dto.issueDate,
      ...(dto.taxRateId === undefined ? {} : { taxRateId: toBigInt(dto.taxRateId) }),
      ...(dto.customerInvoiceId === undefined ? {} : { customerInvoiceId: toBigInt(dto.customerInvoiceId) }),
      ...(dto.supplierInvoiceId === undefined ? {} : { supplierInvoiceId: toBigInt(dto.supplierInvoiceId) }),
      ...(dto.originalDocumentId === undefined ? {} : { originalDocumentId: toBigInt(dto.originalDocumentId) }),
      ...(dto.partyType === undefined ? {} : { partyType: dto.partyType }),
      ...(dto.partyId === undefined ? {} : { partyId: toBigInt(dto.partyId) }),
    });
    return { data: document };
  }

  @Get('accounting/tax-documents/:id')
  @RequirePermissions('accounting.document.read')
  @ApiOperation({ summary: 'جزئیات سند مالیاتی' })
  async getTaxDocument(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.tax.getDocument(ctx, toBigInt(id)) };
  }

  @Post('accounting/tax-documents/:id/issue')
  @RequirePermissions('accounting.document.issue')
  @ApiOperation({ summary: 'صدور سند مالیاتی با شماره یکتا' })
  async issueTaxDocument(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { issueDate?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.tax.issueDocument(ctx, toBigInt(id), body.issueDate) };
  }

  @Post('accounting/tax-documents/:id/void')
  @RequirePermissions('accounting.document.void')
  @ApiOperation({ summary: 'ابطال سند مالیاتی با صدور اعتبارنامه' })
  async voidTaxDocument(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.tax.voidDocument(ctx, toBigInt(id), body.reason) };
  }

  @Get('accounting/tax-documents/:id/export')
  @RequirePermissions('accounting.document.export')
  @ApiOperation({ summary: 'خروجی سند مالیاتی برای مؤدیان' })
  async exportTaxDocument(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('format') format?: string,
  ): Promise<{ data: { payload: string; contentType: string } }> {
    return { data: await this.tax.exportDocument(ctx, toBigInt(id), format === 'xml' ? 'xml' : 'json') };
  }

  /* ------------------------------- valuation ------------------------------- */

  @Get('accounting/valuation-runs')
  @RequirePermissions('accounting.valuation.read')
  @ApiOperation({ summary: 'اجراهای ارزش‌گذاری موجودی' })
  async listValuationRuns(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: readonly unknown[] }> {
    const filter = parseDto(ValuationFilterSchema, query);
    const rows = await this.valuation.listRuns(ctx, {
      ...(filter.method === undefined ? {} : { method: filter.method }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.warehouseId === undefined ? {} : { warehouseId: toBigInt(filter.warehouseId) }),
    });
    return { data: rows };
  }

  @Post('accounting/valuation-runs')
  @RequirePermissions('accounting.valuation.run')
  @ApiOperation({ summary: 'شروع اجرای ارزش‌گذاری (FIFO/میانگین متحرک)' })
  async startValuation(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(StartValuationSchema, body);
    const run = await this.valuation.run(ctx, {
      method: dto.method,
      periodId: toBigInt(dto.periodId),
      ...(dto.warehouseIds === undefined
        ? {}
        : { warehouseIds: dto.warehouseIds.map((id) => toBigInt(id)) }),
      ...(dto.asOf === undefined ? {} : { asOf: dto.asOf }),
    });
    return { data: run };
  }

  @Get('accounting/valuation-runs/:id')
  @RequirePermissions('accounting.valuation.read')
  @ApiOperation({ summary: 'جزئیات اجرای ارزش‌گذاری' })
  async getValuationRun(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.valuation.getRun(ctx, toBigInt(id)) };
  }

  @Get('accounting/valuation-runs/:id/lines')
  @RequirePermissions('accounting.valuation.read')
  @ApiOperation({ summary: 'سطرهای ارزش‌گذاری' })
  async valuationLines(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: readonly unknown[] }> {
    return { data: await this.valuation.runLines(ctx, toBigInt(id)) };
  }

  @Post('accounting/valuation-runs/:id/post')
  @RequirePermissions('accounting.valuation.post')
  @ApiOperation({ summary: 'ثبت سند اصلاح ارزش‌گذاری' })
  async postValuation(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.valuation.post(ctx, toBigInt(id)) };
  }

  /* --------------------------------- closing -------------------------------- */

  @Get('accounting/fiscal-years/:id/closing-run')
  @RequirePermissions('accounting.fiscal_year.read')
  @ApiOperation({ summary: 'وضعیت اجرای بستن سال مالی' })
  async getClosingRun(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: (await this.closing.getRun(ctx, toBigInt(id))) ?? null };
  }

  @Post('accounting/fiscal-years/:id/closing-run')
  @RequirePermissions('accounting.fiscal_year.close')
  @ApiOperation({ summary: 'اجرای بستن سال مالی: سود و زیان → سود انباشته → اندوخته قانونی' })
  async runClosing(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(CloseSchema, body);
    return { data: await this.closing.run(ctx, toBigInt(id), dto.note) };
  }

  @Get('accounting/closing-runs')
  @RequirePermissions('accounting.fiscal_year.read')
  @ApiOperation({ summary: 'تاریخچه اجراهای بستن سال مالی' })
  async listClosingRuns(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.closing.listRuns(ctx) };
  }
}
