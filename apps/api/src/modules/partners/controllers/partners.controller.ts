/** Partners HTTP surface (`API.md §4.13`). */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { PartnersService } from '../partners.service';
import { ProfitDistributionService } from '../profit-distribution.service';
import { SettlementsService } from '../settlements.service';
import {
  AdjustShareSchema,
  ConfirmSettlementSchema,
  CreatePartnerAccountSchema,
  CreatePartnerSchema,
  CreateSettlementSchema,
  CreateShareholderSchema,
  PartnerTransactionSchema,
  RunDistributionSchema,
  parseDto,
  toBigInt,
  toMoney,
} from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';

@ApiTags('partners')
@Controller()
export class PartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly profit: ProfitDistributionService,
    private readonly settlements: SettlementsService,
  ) {}

  @Get('partners')
  @RequirePermissions('partner.read')
  @ApiOperation({ summary: 'فهرست شرکا' })
  async listPartners(
    @Tenant() ctx: TenantContext,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.partners.listPartners(ctx, {
        ...(type === undefined ? {} : { type }),
        ...(status === undefined ? {} : { active: status === 'active' }),
        ...(q === undefined ? {} : { search: q }),
      }),
    };
  }

  @Post('partners')
  @RequirePermissions('partner.create')
  @ApiOperation({ summary: 'ایجاد شریک' })
  async createPartner(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreatePartnerSchema, body);
    return {
      data: await this.partners.createPartner(ctx, {
        code: dto.code ?? `P-${Date.now()}`,
        type: dto.type,
        name: dto.nameFa,
        ...(dto.legalName === undefined ? {} : { legalName: dto.legalName }),
        ...(dto.nationalId === undefined ? {} : { nationalId: dto.nationalId }),
        ...(dto.economicCode === undefined ? {} : { economicCode: dto.economicCode }),
        ...(dto.mobile === undefined ? {} : { mobile: dto.mobile }),
        ...(dto.profitSharePercent === undefined ? {} : { profitSharePercent: dto.profitSharePercent }),
        ...(dto.glAccountId === undefined ? {} : { glAccountId: toBigInt(dto.glAccountId) }),
      }),
    };
  }

  @Get('partners/:id')
  @RequirePermissions('partner.read')
  @ApiOperation({ summary: 'جزئیات شریک + حساب‌ها' })
  async getPartner(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    const partner = await this.partners.getPartner(ctx, toBigInt(id));
    const accounts = await this.partners.partnerAccounts(ctx, partner.id);
    return { data: { partner, accounts } };
  }

  @Patch('partners/:id')
  @RequirePermissions('partner.update')
  @ApiOperation({ summary: 'ویرایش شریک' })
  async updatePartner(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { nameFa?: string; profitSharePercent?: string; status?: string },
    @Query('version') version?: string,
  ): Promise<{ data: unknown }> {
    return {
      data: await this.partners.updatePartner(
        ctx,
        toBigInt(id),
        {
          ...(body.nameFa === undefined ? {} : { name: body.nameFa }),
          ...(body.profitSharePercent === undefined ? {} : { profitSharePercent: body.profitSharePercent }),
          ...(body.status === undefined ? {} : { isActive: body.status === 'active' }),
        },
        version === undefined ? 1 : Number(version),
      ),
    };
  }

  @Delete('partners/:id')
  @RequirePermissions('partner.delete')
  @ApiOperation({ summary: 'حذف شریک بدون مانده' })
  async deletePartner(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.partners.deletePartner(ctx, toBigInt(id));
  }

  @Get('partners/:id/accounts')
  @RequirePermissions('partner.read')
  @ApiOperation({ summary: 'حساب‌های شریک' })
  async partnerAccounts(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: readonly unknown[] }> {
    return { data: await this.partners.partnerAccounts(ctx, toBigInt(id)) };
  }

  @Post('partners/:id/accounts')
  @RequirePermissions('partner.update')
  @ApiOperation({ summary: 'ایجاد حساب شریک (سرمایه/جاری/سود)' })
  async createPartnerAccount(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: readonly unknown[] }> {
    const dto = parseDto(CreatePartnerAccountSchema, body);
    return {
      data: await this.partners.createPartnerAccount(ctx, toBigInt(id), {
        type: dto.type,
        glAccountId: toBigInt(dto.glAccountId),
      }),
    };
  }

  @Post('partner-accounts/:id/transactions')
  @RequirePermissions('partner.transaction.create')
  @ApiOperation({ summary: 'ثبت تراکنش شریک (سرمایه/برداشت/سود)' })
  async createPartnerTransaction(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(PartnerTransactionSchema, body);
    return {
      data: await this.partners.createTransaction(ctx, toBigInt(id), {
        type: dto.type,
        amount: toMoney(dto.amount),
        date: dto.date,
        ...(dto.descriptionFa === undefined ? {} : { description: dto.descriptionFa }),
        ...(dto.paymentId === undefined ? {} : { paymentId: toBigInt(dto.paymentId) }),
      }),
    };
  }

  @Get('partner-accounts/:id/transactions')
  @RequirePermissions('partner.transaction.read')
  @ApiOperation({ summary: 'تراکنش‌های شریک' })
  async partnerTransactions(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('type') type?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.partners.transactions(ctx, toBigInt(id), {
        ...(type === undefined ? {} : { type }),
      }),
    };
  }

  @Get('partners/:id/statement')
  @RequirePermissions('partner.read')
  @ApiOperation({ summary: 'صورت حساب شریک' })
  async partnerStatement(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('from') from?: string,
  ): Promise<{ data: unknown }> {
    return {
      data: await this.partners.statement(ctx, toBigInt(id), {
        ...(from === undefined ? {} : { dateFrom: from }),
      }),
    };
  }

  @Get('shareholders')
  @RequirePermissions('shareholder.read')
  @ApiOperation({ summary: 'سهامداران' })
  async listShareholders(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.partners.listShareholders(ctx, {}) };
  }

  @Post('shareholders')
  @RequirePermissions('shareholder.create')
  @ApiOperation({ summary: 'ایجاد سهامدار' })
  async createShareholder(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: readonly unknown[] }> {
    const dto = parseDto(CreateShareholderSchema, body);
    return {
      data: await this.partners.createShareholder(ctx, {
        code: dto.code ?? `S-${Date.now()}`,
        name: dto.nameFa,
        shareholderType: dto.shareholderType ?? 'person',
        sharePercent: dto.sharePercent,
        ...(dto.nationalId === undefined ? {} : { nationalId: dto.nationalId }),
      }),
    };
  }

  @Post('shareholders/:id/share-adjustments')
  @RequirePermissions('shareholder.share.adjust')
  @ApiOperation({ summary: 'تعدیل درصد سهام (جمع ۱۰۰٪)' })
  async adjustShare(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: readonly unknown[] }> {
    const dto = parseDto(AdjustShareSchema, body);
    return {
      data: await this.partners.adjustShare(ctx, toBigInt(id), {
        sharePercent: dto.sharePercent,
        effectiveDate: dto.effectiveDate,
        reason: dto.reason,
      }),
    };
  }

  @Post('shareholders/:id/transactions')
  @RequirePermissions('shareholder.transaction.create')
  @ApiOperation({ summary: 'تراکنش سهامدار' })
  async createShareholderTransaction(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { type: 'capital_in' | 'capital_out' | 'dividend' | 'adjustment'; amount: string; date: string; descriptionFa?: string },
  ): Promise<{ data: unknown }> {
    return {
      data: await this.partners.createShareholderTransaction(ctx, toBigInt(id), {
        type: body.type,
        amount: toMoney(body.amount),
        date: body.date,
        ...(body.descriptionFa === undefined ? {} : { description: body.descriptionFa }),
      }),
    };
  }

  /* --------------------------- profit distribution -------------------------- */

  @Get('profit-distributions')
  @RequirePermissions('profit.distribution.read')
  @ApiOperation({ summary: 'اجراهای توزیع سود' })
  async listDistributions(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.profit.listRuns(ctx) };
  }

  @Post('profit-distributions')
  @RequirePermissions('profit.distribution.run')
  @ApiOperation({ summary: 'محاسبه توزیع سود از سود انباشته سال بسته‌شده' })
  async runDistribution(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(RunDistributionSchema, body);
    return {
      data: await this.profit.run(ctx, {
        fiscalYearId: toBigInt(dto.fiscalYearId),
        policy: dto.policy,
        ...(dto.customShares === undefined
          ? {}
          : {
              customShares: dto.customShares.map((share) => ({
                shareholderId: toBigInt(share.shareholderId),
                ownershipPercent: share.ownershipPercent,
              })),
            }),
        ...(dto.note === undefined ? {} : { note: dto.note }),
      }),
    };
  }

  @Get('profit-distributions/:id')
  @RequirePermissions('profit.distribution.read')
  @ApiOperation({ summary: 'جزئیات توزیع سود' })
  async getDistribution(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.profit.getRun(ctx, toBigInt(id)) };
  }

  @Post('profit-distributions/:id/approve')
  @RequirePermissions('profit.distribution.approve')
  @ApiOperation({ summary: 'تأیید توزیع سود' })
  async approveDistribution(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.profit.approve(ctx, toBigInt(id), body.note) };
  }

  @Post('profit-distributions/:id/post')
  @RequirePermissions('profit.distribution.run')
  @ApiOperation({ summary: 'ثبت سند توزیع سود' })
  async postDistribution(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.profit.post(ctx, toBigInt(id)) };
  }

  @Post('profit-distributions/:id/reverse')
  @RequirePermissions('profit.distribution.run')
  @ApiOperation({ summary: 'برگشت توزیع سود' })
  async reverseDistribution(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.profit.reverse(ctx, toBigInt(id), body.reason) };
  }

  /* ---------------------------- channel settlements ------------------------- */

  @Get('channel-settlements')
  @RequirePermissions('settlement.read')
  @ApiOperation({ summary: 'تسویه‌های کانال' })
  async listSettlements(
    @Tenant() ctx: TenantContext,
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.settlements.list(ctx, {
        ...(accountId === undefined ? {} : { channelAccountId: toBigInt(accountId) }),
        ...(status === undefined ? {} : { status }),
      }),
    };
  }

  @Post('channel-settlements')
  @RequirePermissions('settlement.create')
  @ApiOperation({ summary: 'ثبت صورت تسویه کانال (بررسی فرمول خالص)' })
  async createSettlement(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateSettlementSchema, body);
    return {
      data: await this.settlements.create(ctx, {
        channelAccountId: toBigInt(dto.accountId),
        ...(dto.externalStatementId === undefined ? {} : { externalSettlementId: dto.externalStatementId }),
        periodStart: dto.periodFrom,
        periodEnd: dto.periodTo,
        grossSalesAmount: toMoney(dto.grossAmount),
        commissionAmount: dto.commissionAmount === undefined ? 0n : toMoney(dto.commissionAmount),
        feeAmount: dto.feeAmount === undefined ? 0n : toMoney(dto.feeAmount),
        returnAmount: dto.returnAmount === undefined ? 0n : toMoney(dto.returnAmount),
        taxAmount: dto.taxAmount === undefined ? 0n : toMoney(dto.taxAmount),
        netPayableAmount: toMoney(dto.netAmount),
        ...(dto.lines === undefined
          ? {}
          : {
              lines: dto.lines.map((line) => ({
                lineType: line.lineType,
                amount: toMoney(line.amount),
                ...(line.salesOrderId === undefined ? {} : { salesOrderId: toBigInt(line.salesOrderId) }),
                ...(line.externalReference === undefined ? {} : { externalReference: line.externalReference }),
              })),
            }),
      }),
    };
  }

  @Get('channel-settlements/:id')
  @RequirePermissions('settlement.read')
  @ApiOperation({ summary: 'جزئیات تسویه' })
  async getSettlement(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.settlements.get(ctx, toBigInt(id)) };
  }

  @Post('channel-settlements/:id/confirm')
  @RequirePermissions('settlement.confirm')
  @ApiOperation({ summary: 'تأیید تسویه با تطبیق سطرها' })
  async confirmSettlement(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(ConfirmSettlementSchema, body);
    return {
      data: await this.settlements.confirm(ctx, toBigInt(id), {
        ...(dto.tolerance === undefined ? {} : { tolerance: toMoney(dto.tolerance) }),
      }),
    };
  }

  @Post('channel-settlements/:id/post')
  @RequirePermissions('settlement.confirm')
  @ApiOperation({ summary: 'ثبت سند تسویه (بدون شناسایی مجدد درآمد)' })
  async postSettlement(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.settlements.post(ctx, toBigInt(id)) };
  }

  @Post('channel-settlements/:id/pay')
  @RequirePermissions('settlement.confirm')
  @ApiOperation({ summary: 'اتصال پرداخت به تسویه' })
  async paySettlement(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { paymentId: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.settlements.attachPayment(ctx, toBigInt(id), toBigInt(body.paymentId)) };
  }
}
