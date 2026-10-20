/** Financial reports HTTP surface (`API.md §4.11` read models). */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { AccountingReportsService } from '../reports/accounting-reports.service';
import { BalanceQuerySchema, JournalBookQuerySchema, LedgerQuerySchema, SubLedgerQuerySchema, parseDto, toBigInt } from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';

function moneyOut(value: bigint): string {
  return value.toString();
}

@ApiTags('accounting')
@Controller('accounting')
export class AccountingReportsController {
  constructor(private readonly reports: AccountingReportsService) {}

  @Get('account-balances')
  @RequirePermissions('accounting.balance.read')
  @ApiOperation({ summary: 'مانده حساب‌ها به تفکیک دوره (منبع تراز آزمایشی)' })
  async balances(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown }> {
    const filter = parseDto(BalanceQuerySchema, query);
    const trial = await this.reports.trialBalance(ctx, {
      ...(filter.fiscalYearId === undefined ? {} : { fiscalYearId: toBigInt(filter.fiscalYearId) }),
      ...(filter.periodId === undefined ? {} : { periodId: toBigInt(filter.periodId) }),
    });
    const rows = filter.accountId === undefined
      ? trial.rows
      : trial.rows.filter((row) => row.accountCode !== undefined && row.accountCode.length > 0);
    return {
      data: {
        rows: rows.map((row) => ({
          accountCode: row.accountCode,
          nameFa: row.nameFa,
          type: row.accountType,
          normalBalance: row.normalBalance,
          debit: moneyOut(row.debit),
          credit: moneyOut(row.credit),
          balance: moneyOut(row.balance),
        })),
        totalDebit: moneyOut(trial.totalDebit),
        totalCredit: moneyOut(trial.totalCredit),
        balanced: trial.balanced,
      },
    };
  }

  @Get('general-ledger')
  @RequirePermissions('accounting.ledger.read')
  @ApiOperation({ summary: 'دفتر کل تفصیلی' })
  async ledger(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown[] }> {
    const filter = parseDto(LedgerQuerySchema, query);
    const rows = await this.reports.ledger(ctx, {
      ...(filter.accountId === undefined ? {} : { accountId: toBigInt(filter.accountId) }),
      ...(filter.dateFrom === undefined ? {} : { dateFrom: filter.dateFrom }),
      ...(filter.dateTo === undefined ? {} : { dateTo: filter.dateTo }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      ...(filter.offset === undefined ? {} : { offset: filter.offset }),
    });
    return {
      data: rows.map((row) => ({
        journalId: row.journalId.toString(),
        number: row.entryNo,
        date: row.entryDate,
        accountCode: row.accountCode,
        description: row.description ?? row.journalDescription,
        debit: moneyOut(row.debit),
        credit: moneyOut(row.credit),
        partnerType: row.partnerType,
        partnerId: row.partnerId === null ? null : row.partnerId.toString(),
      })),
    };
  }

  @Get('sub-ledger')
  @RequirePermissions('accounting.ledger.read')
  @ApiOperation({ summary: 'دفتر معین طرف حساب (کنترل دریافتنی/پرداختنی)' })
  async subLedger(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown[] }> {
    const filter = parseDto(SubLedgerQuerySchema, query);
    const rows = await this.reports.subLedger(ctx, {
      partyType: filter.partyType,
      ...(filter.partyId === undefined ? {} : { partyId: toBigInt(filter.partyId) }),
      ...(filter.dateFrom === undefined ? {} : { dateFrom: filter.dateFrom }),
    });
    return {
      data: rows.map((row) => ({
        partnerType: row.partnerType,
        partnerId: row.partnerId === null ? null : row.partnerId.toString(),
        debit: moneyOut(row.debit),
        credit: moneyOut(row.credit),
        balance: moneyOut(row.debit - row.credit),
      })),
    };
  }

  @Get('journal-book')
  @RequirePermissions('accounting.journal.read')
  @ApiOperation({ summary: 'دفتر روزنامه' })
  async journalBook(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown[] }> {
    const filter = parseDto(JournalBookQuerySchema, query);
    const rows = await this.reports.journalBook(ctx, {
      ...(filter.fiscalYearId === undefined ? {} : { fiscalYearId: toBigInt(filter.fiscalYearId) }),
      ...(filter.dateFrom === undefined ? {} : { dateFrom: filter.dateFrom }),
      ...(filter.dateTo === undefined ? {} : { dateTo: filter.dateTo }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      ...(filter.offset === undefined ? {} : { offset: filter.offset }),
    });
    return {
      data: rows.map((row) => ({
        journalId: row.journalId.toString(),
        number: row.entryNo,
        date: row.entryDate,
        type: row.entryType,
        description: row.description,
        sourceType: row.sourceType,
        debit: moneyOut(row.debit),
        credit: moneyOut(row.credit),
        lineCount: row.lineCount,
      })),
    };
  }

  @Get('trial-balance')
  @RequirePermissions('accounting.balance.read')
  @ApiOperation({ summary: 'تراز آزمایشی' })
  async trialBalance(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown }> {
    const filter = parseDto(BalanceQuerySchema, query);
    const trial = await this.reports.trialBalance(ctx, {
      ...(filter.fiscalYearId === undefined ? {} : { fiscalYearId: toBigInt(filter.fiscalYearId) }),
      ...(filter.periodId === undefined ? {} : { periodId: toBigInt(filter.periodId) }),
    });
    return {
      data: {
        rows: trial.rows.map((row) => ({
          accountCode: row.accountCode,
          nameFa: row.nameFa,
          debit: moneyOut(row.debit),
          credit: moneyOut(row.credit),
        })),
        totalDebit: moneyOut(trial.totalDebit),
        totalCredit: moneyOut(trial.totalCredit),
        balanced: trial.balanced,
      },
    };
  }

  @Get('income-statement')
  @RequirePermissions('accounting.balance.read')
  @ApiOperation({ summary: 'صورت سود و زیان' })
  async incomeStatement(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown }> {
    const filter = parseDto(BalanceQuerySchema, query);
    if (filter.fiscalYearId === undefined) {
      return { data: null };
    }
    const pnl = await this.reports.profitAndLoss(ctx, {
      fiscalYearId: toBigInt(filter.fiscalYearId),
      ...(filter.periodId === undefined ? {} : { periodId: toBigInt(filter.periodId) }),
    });
    const map = (rows: typeof pnl.revenue) => rows.map((row) => ({
      accountCode: row.accountCode,
      nameFa: row.nameFa,
      amount: moneyOut(row.balance),
    }));
    return {
      data: {
        revenue: map(pnl.revenue),
        expenses: map(pnl.expenses),
        revenueTotal: moneyOut(pnl.revenueTotal),
        expenseTotal: moneyOut(pnl.expenseTotal),
        netProfit: moneyOut(pnl.netProfit),
      },
    };
  }

  @Get('balance-sheet')
  @RequirePermissions('accounting.balance.read')
  @ApiOperation({ summary: 'ترازنامه' })
  async balanceSheet(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown }> {
    const filter = parseDto(BalanceQuerySchema, query);
    if (filter.fiscalYearId === undefined) {
      return { data: null };
    }
    const sheet = await this.reports.balanceSheet(ctx, {
      fiscalYearId: toBigInt(filter.fiscalYearId),
      ...(filter.periodId === undefined ? {} : { periodId: toBigInt(filter.periodId) }),
    });
    const map = (rows: typeof sheet.assets) => rows.map((row) => ({
      accountCode: row.accountCode,
      nameFa: row.nameFa,
      amount: moneyOut(row.balance),
    }));
    return {
      data: {
        assets: map(sheet.assets),
        liabilities: map(sheet.liabilities),
        equity: map(sheet.equity),
        assetsTotal: moneyOut(sheet.assetsTotal),
        liabilitiesTotal: moneyOut(sheet.liabilitiesTotal),
        equityTotal: moneyOut(sheet.equityTotal),
        balanced: sheet.balanced,
      },
    };
  }

  @Get('cash-flow')
  @RequirePermissions('accounting.ledger.read')
  @ApiOperation({ summary: 'خلاصه جریان نقدی' })
  async cashFlow(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown[] }> {
    const filter = parseDto(LedgerQuerySchema, query);
    const rows = await this.reports.cashFlow(ctx, {
      ...(filter.dateFrom === undefined ? {} : { dateFrom: filter.dateFrom }),
      ...(filter.dateTo === undefined ? {} : { dateTo: filter.dateTo }),
    });
    return {
      data: rows.map((row) => ({ bucket: row.bucket, inflow: moneyOut(row.inflow), outflow: moneyOut(row.outflow) })),
    };
  }
}
