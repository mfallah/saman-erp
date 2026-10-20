/** CoA and fiscal-calendar HTTP surface (`API.md §4.11`). */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { ChartOfAccountsService } from '../coa/chart-of-accounts.service';
import { FiscalCalendarService } from '../periods/fiscal-calendar.service';
import { AccountFilterSchema, CloseSchema, CreateAccountSchema, CreateFiscalYearSchema, ReopenSchema, UpdateAccountSchema, parseDto, toBigInt } from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';
import { accountOut, fiscalYearOut, periodOut } from '../http/serialise';

@ApiTags('accounting')
@Controller('accounting')
export class AccountingStructureController {
  constructor(
    private readonly coa: ChartOfAccountsService,
    private readonly calendar: FiscalCalendarService,
  ) {}

  @Get('accounts')
  @RequirePermissions('accounting.coa.read')
  @ApiOperation({ summary: 'فهرست حساب‌های نمودار حساب' })
  async listAccounts(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: readonly unknown[] }> {
    const filter = parseDto(AccountFilterSchema, query);
    const accounts = await this.coa.list(ctx, {
      ...(filter.level === undefined ? {} : { level: filter.level }),
      ...(filter.parentId === undefined ? {} : { parentId: toBigInt(filter.parentId) }),
      ...(filter.type === undefined ? {} : { type: filter.type }),
      ...(filter.active === undefined ? {} : { active: filter.active }),
      ...(filter.code === undefined ? {} : { codePrefix: filter.code }),
      page: {
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
      },
    });
    return { data: accounts.map(accountOut) };
  }

  @Get('accounts/tree')
  @RequirePermissions('accounting.coa.read')
  @ApiOperation({ summary: 'درخت کامل نمودار حساب' })
  async tree(
    @Tenant() ctx: TenantContext,
    @Query() query: unknown,
  ): Promise<{ data: readonly unknown[] }> {
    const parsed = parseDto(AccountFilterSchema, query);
    const nodes = await this.coa.tree(ctx, {
      ...(parsed.level === undefined ? {} : { depth: parsed.level }),
      ...(parsed.active === undefined ? {} : { activeOnly: parsed.active }),
    });
    return { data: nodes };
  }

  @Get('accounts/:id')
  @RequirePermissions('accounting.coa.read')
  @ApiOperation({ summary: 'جزئیات حساب' })
  async getAccount(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: accountOut(await this.coa.get(ctx, toBigInt(id))) };
  }

  @Post('accounts')
  @RequirePermissions('accounting.coa.create')
  @ApiOperation({ summary: 'ایجاد حساب' })
  async createAccount(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateAccountSchema, body);
    const account = await this.coa.create(ctx, {
      code: dto.code,
      nameFa: dto.nameFa,
      ...(dto.nameEn === undefined ? {} : { nameEn: dto.nameEn }),
      ...(dto.parentId === undefined ? {} : { parentId: toBigInt(dto.parentId) }),
      type: dto.type,
      level: dto.level,
      isPostable: dto.isPostable,
      ...(dto.currency === undefined ? {} : { currency: dto.currency }),
    });
    return { data: accountOut(account) };
  }

  @Patch('accounts/:id')
  @RequirePermissions('accounting.coa.update')
  @ApiOperation({ summary: 'ویرایش حساب' })
  async updateAccount(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('version') version?: string,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(UpdateAccountSchema, body);
    const account = await this.coa.update(ctx, toBigInt(id), dto, version === undefined ? 0 : Number(version));
    return { data: accountOut(account) };
  }

  @Delete('accounts/:id')
  @RequirePermissions('accounting.coa.delete')
  @ApiOperation({ summary: 'حذف حساب بدون گردش' })
  async deleteAccount(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.coa.delete(ctx, toBigInt(id));
  }

  @Post('accounts/import')
  @RequirePermissions('accounting.coa.import')
  @ApiOperation({ summary: 'ورود نمودار حساب استاندارد (idempotent)' })
  async importAccounts(@Tenant() ctx: TenantContext): Promise<{ data: { created: number } }> {
    return { data: await this.coa.importManifest(ctx) };
  }

  @Get('fiscal-years')
  @RequirePermissions('accounting.fiscal_year.read')
  @ApiOperation({ summary: 'سال‌های مالی' })
  async listYears(
    @Tenant() ctx: TenantContext,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return { data: (await this.calendar.listYears(ctx, status)).map(fiscalYearOut) };
  }

  @Get('fiscal-years/:id')
  @RequirePermissions('accounting.fiscal_year.read')
  @ApiOperation({ summary: 'جزئیات سال مالی و دوره‌ها' })
  async getYear(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    const { year, periods } = await this.calendar.getYear(ctx, toBigInt(id));
    return { data: { ...fiscalYearOut(year), periods: periods.map(periodOut) } };
  }

  @Post('fiscal-years')
  @RequirePermissions('accounting.fiscal_year.create')
  @ApiOperation({ summary: 'ایجاد سال مالی و دوره‌های ماهانه جلالی' })
  async createYear(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateFiscalYearSchema, body);
    const { year, periods } = await this.calendar.createYear(ctx, {
      startDate: dto.startDate,
      endDate: dto.endDate,
      title: dto.title,
      ...(dto.code === undefined ? {} : { code: dto.code }),
    });
    return { data: { ...fiscalYearOut(year), periods: periods.map(periodOut) } };
  }

  @Post('fiscal-years/:id/close')
  @RequirePermissions('accounting.fiscal_year.close')
  @ApiOperation({ summary: 'بستن سال مالی' })
  async closeYear(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(CloseSchema, body);
    return { data: fiscalYearOut(await this.calendar.closeYear(ctx, toBigInt(id), dto.note ?? '')) };
  }

  @Get('periods')
  @RequirePermissions('accounting.period.read')
  @ApiOperation({ summary: 'دوره‌های مالی' })
  async listPeriods(
    @Tenant() ctx: TenantContext,
    @Query('fiscalYearId') fiscalYearId: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return { data: (await this.calendar.listPeriods(ctx, toBigInt(fiscalYearId), status)).map(periodOut) };
  }

  @Post('fiscal-years/:id/adjustment-period')
  @RequirePermissions('accounting.period.close')
  @ApiOperation({ summary: 'ایجاد دوره ۱۳ تعدیلات' })
  async addAdjustment(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<{ data: unknown }> {
    return { data: periodOut(await this.calendar.addAdjustmentPeriod(ctx, toBigInt(id))) };
  }

  @Post('periods/:id/close')
  @RequirePermissions('accounting.period.close')
  @ApiOperation({ summary: 'بستن دوره مالی' })
  async closePeriod(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(CloseSchema, body);
    return { data: periodOut(await this.calendar.closePeriod(ctx, toBigInt(id), dto.note)) };
  }

  @Post('periods/:id/reopen')
  @RequirePermissions('accounting.period.reopen')
  @ApiOperation({ summary: 'بازگشایی دوره مالی با دلیل' })
  async reopenPeriod(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(ReopenSchema, body);
    return { data: periodOut(await this.calendar.reopenPeriod(ctx, toBigInt(id), dto.reason)) };
  }

  @Post('fiscal-years/:id/reopen')
  @RequirePermissions('accounting.fiscal_year.reopen')
  @ApiOperation({ summary: 'بازگشایی سال مالی (فقط سوپرادمین)' })
  async reopenYear(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(ReopenSchema, body);
    return { data: fiscalYearOut(await this.calendar.reopenYear(ctx, toBigInt(id), dto.reason)) };
  }
}
