/** Treasury HTTP surface (`API.md §4.12`). */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import type { PaymentService } from '../payments/payment.service';
import type { ChequeService } from '../cheque/cheque.service';
import type { BankService } from '../bank/bank.service';
import type { CashService } from '../cash/cash.service';
import {
  AllocatePaymentSchema,
  CloseCashSessionSchema,
  CompleteReconciliationSchema,
  CreateBankAccountSchema,
  CreateCashBoxSchema,
  CreateCashTransactionSchema,
  CreateChequeSchema,
  CreatePaymentSchema,
  CreateReconciliationSchema,
  ImportStatementSchema,
  MatchSchema,
  OpenCashSessionSchema,
  parseDto,
  toBigInt,
  toMoney,
} from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';

@ApiTags('treasury')
@Controller('treasury')
export class TreasuryController {
  constructor(
    private readonly payments: PaymentService,
    private readonly cheques: ChequeService,
    private readonly bank: BankService,
    private readonly cash: CashService,
  ) {}

  /* -------------------------------- payments ------------------------------- */

  @Get('payments')
  @RequirePermissions('payment.read')
  @ApiOperation({ summary: 'فهرست پرداخت‌ها' })
  async listPayments(
    @Tenant() ctx: TenantContext,
    @Query('direction') direction?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: readonly unknown[] }> {
    const rows = await this.payments.list(ctx, {
      ...(direction === undefined ? {} : { direction }),
      ...(status === undefined ? {} : { status }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
    return { data: rows };
  }

  @Post('payments')
  @RequirePermissions('payment.create')
  @ApiOperation({ summary: 'ایجاد پیش‌نویس پرداخت' })
  async createPayment(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreatePaymentSchema, body);
    const payment = await this.payments.create(ctx, {
      direction: dto.direction,
      method: dto.method,
      amount: toMoney(dto.amount),
      paymentDate: dto.date,
      ...(dto.customerId === undefined ? {} : { customerId: toBigInt(dto.customerId) }),
      ...(dto.supplierId === undefined ? {} : { supplierId: toBigInt(dto.supplierId) }),
      ...(dto.partnerId === undefined ? {} : { partnerId: toBigInt(dto.partnerId) }),
      ...(dto.bankAccountId === undefined ? {} : { bankAccountId: toBigInt(dto.bankAccountId) }),
      ...(dto.cashBoxId === undefined ? {} : { cashAccountId: toBigInt(dto.cashBoxId) }),
      ...(dto.chequeId === undefined ? {} : { chequeId: toBigInt(dto.chequeId) }),
      ...(dto.salesOrderId === undefined ? {} : { salesOrderId: toBigInt(dto.salesOrderId) }),
      ...(dto.purchaseOrderId === undefined ? {} : { purchaseOrderId: toBigInt(dto.purchaseOrderId) }),
      ...(dto.refundId === undefined ? {} : { refundId: toBigInt(dto.refundId) }),
      ...(dto.descriptionFa === undefined ? {} : { description: dto.descriptionFa }),
      ...(dto.reference === undefined ? {} : { referenceNo: dto.reference }),
      ...(dto.allocations === undefined
        ? {}
        : {
            allocations: dto.allocations.map((item) => ({
              documentType: item.documentType,
              documentId: toBigInt(item.documentId),
              amount: toMoney(item.amount),
            })),
          }),
    });
    return { data: payment };
  }

  @Get('payments/:id')
  @RequirePermissions('payment.read')
  @ApiOperation({ summary: 'جزئیات پرداخت' })
  async getPayment(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.payments.get(ctx, toBigInt(id)) };
  }

  @Post('payments/:id/submit')
  @RequirePermissions('payment.submit')
  @ApiOperation({ summary: 'ارسال پرداخت برای تأیید' })
  async submitPayment(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.payments.submit(ctx, toBigInt(id)) };
  }

  @Post('payments/:id/approve')
  @RequirePermissions('payment.approve')
  @ApiOperation({ summary: 'تأیید پرداخت' })
  async approvePayment(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.payments.approve(ctx, toBigInt(id), body.note) };
  }

  @Post('payments/:id/execute')
  @RequirePermissions('payment.execute')
  @ApiOperation({ summary: 'اجرای پرداخت و ثبت سند حسابداری' })
  async executePayment(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { executedAt?: string; reference?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.payments.execute(ctx, toBigInt(id), body) };
  }

  @Post('payments/:id/void')
  @RequirePermissions('payment.void')
  @ApiOperation({ summary: 'ابطال پرداخت اجرانشده' })
  async voidPayment(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.payments.void(ctx, toBigInt(id), body.reason) };
  }

  @Get('payments/:id/allocations')
  @RequirePermissions('payment.read')
  @ApiOperation({ summary: 'تخصیص‌های پرداخت' })
  async allocations(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: readonly unknown[] }> {
    return { data: await this.payments.allocations(ctx, toBigInt(id)) };
  }

  @Post('payments/:id/allocations')
  @RequirePermissions('payment.allocate')
  @ApiOperation({ summary: 'تخصیص پرداخت/علی‌الحساب به اسناد (سقف مبلغ)' })
  async allocate(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: readonly unknown[] }> {
    const dto = parseDto(AllocatePaymentSchema, body);
    return {
      data: await this.payments.allocate(
        ctx,
        toBigInt(id),
        dto.items.map((item) => ({
          documentType: item.documentType,
          documentId: toBigInt(item.documentId),
          amount: toMoney(item.amount),
        })),
      ),
    };
  }

  @Delete('payments/:id/allocations/:allocationId')
  @RequirePermissions('payment.allocate')
  @ApiOperation({ summary: 'حذف تخصیص' })
  async deallocate(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('allocationId') allocationId: string,
  ): Promise<void> {
    await this.payments.deallocate(ctx, toBigInt(id), toBigInt(allocationId));
  }

  /* --------------------------------- cheques ------------------------------- */

  @Get('cheques')
  @RequirePermissions('cheque.read')
  @ApiOperation({ summary: 'فهرست چک‌ها' })
  async listCheques(
    @Tenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('dueDate') dueDate?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.cheques.list(ctx, {
        ...(status === undefined ? {} : { status }),
        ...(direction === undefined ? {} : { direction }),
        ...(dueDate === undefined ? {} : { dueFrom: dueDate }),
      }),
    };
  }

  @Post('cheques')
  @RequirePermissions('cheque.issue')
  @ApiOperation({ summary: 'ثبت چک دریافتی/پرداختنی' })
  async createCheque(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateChequeSchema, body);
    return {
      data: await this.cheques.create(ctx, {
        direction: dto.direction,
        partyType: dto.partyType,
        partyId: toBigInt(dto.partyId),
        amount: toMoney(dto.amount),
        chequeNo: dto.chequeNumber,
        dueDate: dto.dueDate,
        ...(dto.issueDate === undefined ? {} : { issueDate: dto.issueDate }),
        ...(dto.bankName === undefined ? {} : { bankName: dto.bankName }),
        ...(dto.bankAccountId === undefined ? {} : { bankAccountId: toBigInt(dto.bankAccountId) }),
        ...(dto.cashBoxId === undefined ? {} : { cashAccountId: toBigInt(dto.cashBoxId) }),
        ...(dto.sayadId === undefined ? {} : { sayadId: dto.sayadId }),
      }),
    };
  }

  @Get('cheques/:id')
  @RequirePermissions('cheque.read')
  @ApiOperation({ summary: 'جزئیات چک' })
  async getCheque(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.cheques.get(ctx, toBigInt(id)) };
  }

  @Post('cheques/:id/deposit')
  @RequirePermissions('cheque.deposit')
  @ApiOperation({ summary: 'سپرده چک به بانک' })
  async deposit(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { bankAccountId: string; depositedAt?: string },
  ): Promise<{ data: unknown }> {
    return {
      data: await this.cheques.deposit(ctx, toBigInt(id), {
        bankAccountId: toBigInt(body.bankAccountId),
        ...(body.depositedAt === undefined ? {} : { depositedAt: body.depositedAt }),
      }),
    };
  }

  @Post('cheques/:id/clear')
  @RequirePermissions('cheque.clear')
  @ApiOperation({ summary: 'وصول چک' })
  async clear(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { clearedAt?: string; bankReference?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.cheques.clear(ctx, toBigInt(id), body) };
  }

  @Post('cheques/:id/bounce')
  @RequirePermissions('cheque.bounce')
  @ApiOperation({ summary: 'برگشت چک (قبل/بعد از وصول)' })
  async bounce(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { bouncedAt?: string; reason: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.cheques.bounce(ctx, toBigInt(id), body) };
  }

  @Post('cheques/:id/endorse')
  @RequirePermissions('cheque.endorse')
  @ApiOperation({ summary: 'ظهرنویسی چک' })
  async endorse(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { endorsedTo: string; endorsedAt?: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.cheques.endorse(ctx, toBigInt(id), body) };
  }

  @Post('cheques/:id/cancel')
  @RequirePermissions('cheque.cancel')
  @ApiOperation({ summary: 'ابطال چک' })
  async cancel(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ): Promise<{ data: unknown }> {
    return { data: await this.cheques.cancel(ctx, toBigInt(id), body.reason) };
  }

  @Get('cheques/:id/events')
  @RequirePermissions('cheque.read')
  @ApiOperation({ summary: 'تاریخچه رویدادهای چک' })
  async chequeEvents(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: readonly unknown[] }> {
    return { data: await this.cheques.eventHistory(ctx, toBigInt(id)) };
  }

  /* ------------------------------ bank & cash ------------------------------ */

  @Get('bank-accounts')
  @RequirePermissions('bank.account.read')
  @ApiOperation({ summary: 'حساب‌های بانکی' })
  async listBankAccounts(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.bank.listAccounts(ctx, {}) };
  }

  @Post('bank-accounts')
  @RequirePermissions('bank.account.create')
  @ApiOperation({ summary: 'ایجاد حساب بانکی' })
  async createBankAccount(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateBankAccountSchema, body);
    return {
      data: await this.bank.createAccount(ctx, {
        code: dto.code ?? dto.accountNumber,
        bankName: dto.bankName,
        accountNo: dto.accountNumber,
        ...(dto.iban === undefined ? {} : { iban: dto.iban }),
        glAccountId: toBigInt(dto.glAccountId),
        ...(dto.branchId === undefined ? {} : { branchId: toBigInt(dto.branchId) }),
        ...(dto.openingBalance === undefined ? {} : { openingBalance: toMoney(dto.openingBalance) }),
      }),
    };
  }

  @Post('bank-accounts/:id/statement-imports')
  @RequirePermissions('bank.statement.import')
  @ApiOperation({ summary: 'ورود صورت حساب بانکی' })
  async importStatement(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(ImportStatementSchema, body);
    return {
      data: await this.bank.importStatement(ctx, {
        bankAccountId: toBigInt(id),
        statementNo: dto.statementNo,
        periodStart: dto.from,
        periodEnd: dto.to,
        openingBalance: toMoney(dto.openingBalance),
        closingBalance: toMoney(dto.closingBalance),
        source: dto.format === 'xlsx' ? 'excel' : 'csv',
        ...(dto.fileId === undefined ? {} : { fileId: toBigInt(dto.fileId) }),
        lines: dto.lines.map((line) => ({
          lineNo: line.lineNo,
          valueDate: line.valueDate,
          direction: line.direction,
          amount: toMoney(line.amount),
          ...(line.description === undefined ? {} : { description: line.description }),
          ...(line.bankReference === undefined ? {} : { bankReference: line.bankReference }),
        })),
      }),
    };
  }

  @Get('bank-statements/:id')
  @RequirePermissions('bank.statement.read')
  @ApiOperation({ summary: 'جزئیات صورت حساب بانکی' })
  async getStatement(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.bank.getStatement(ctx, toBigInt(id)) };
  }

  @Get('bank-statements/:id/lines')
  @RequirePermissions('bank.statement.read')
  @ApiOperation({ summary: 'سطرهای صورت حساب' })
  async statementLines(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('matchStatus') matchStatus?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return { data: await this.bank.statementLines(ctx, toBigInt(id), matchStatus) };
  }

  @Post('reconciliations')
  @RequirePermissions('reconciliation.create')
  @ApiOperation({ summary: 'شروع مغایرت‌گیری بانکی' })
  async createReconciliation(
    @Tenant() ctx: TenantContext,
    @Body() body: unknown,
  ): Promise<{ data: { id: string } }> {
    const dto = parseDto(CreateReconciliationSchema, body);
    const id = await this.bank.createReconciliation(ctx, {
      bankAccountId: toBigInt(dto.bankAccountId),
      statementId: toBigInt(dto.statementId),
    });
    return { data: { id: id.toString() } };
  }

  @Get('reconciliations/:id')
  @RequirePermissions('reconciliation.read')
  @ApiOperation({ summary: 'جزئیات مغایرت‌گیری' })
  async getReconciliation(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.bank.getReconciliation(ctx, toBigInt(id)) };
  }

  @Post('reconciliations/:id/match')
  @RequirePermissions('reconciliation.match')
  @ApiOperation({ summary: 'تطبیق سطرهای صورت حساب' })
  async match(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(MatchSchema, body);
    return {
      data: await this.bank.match(
        ctx,
        toBigInt(id),
        dto.items.map((item) => ({
          statementLineId: toBigInt(item.statementLineId),
          ...(item.paymentId === undefined ? {} : { paymentId: toBigInt(item.paymentId) }),
          ...(item.bankTransactionId === undefined ? {} : { bankTransactionId: toBigInt(item.bankTransactionId) }),
          ...(item.journalLineId === undefined ? {} : { journalLineId: toBigInt(item.journalLineId) }),
          ...(item.amount === undefined ? {} : { amount: toMoney(item.amount) }),
          ...(item.notes === undefined ? {} : { notes: item.notes }),
        })),
      ),
    };
  }

  @Post('reconciliations/:id/unmatch')
  @RequirePermissions('reconciliation.match')
  @ApiOperation({ summary: 'لغو تطبیق' })
  async unmatch(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { matchId: string },
  ): Promise<void> {
    await this.bank.unmatch(ctx, toBigInt(id), toBigInt(body.matchId));
  }

  @Post('reconciliations/:id/complete')
  @RequirePermissions('reconciliation.complete')
  @ApiOperation({ summary: 'تکمیل مغایرت‌گیری' })
  async complete(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parseDto(CompleteReconciliationSchema, body);
    await this.bank.complete(ctx, toBigInt(id), {
      note: dto.note,
      ...(dto.tolerance === undefined ? {} : { tolerance: toMoney(dto.tolerance) }),
    });
  }

  @Get('cash-boxes')
  @RequirePermissions('cash.read')
  @ApiOperation({ summary: 'صندوق‌ها' })
  async listCashBoxes(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.cash.listBoxes(ctx, {}) };
  }

  @Post('cash-boxes')
  @RequirePermissions('cash.create')
  @ApiOperation({ summary: 'ایجاد صندوق' })
  async createCashBox(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateCashBoxSchema, body);
    return {
      data: await this.cash.createBox(ctx, {
        code: dto.code,
        nameFa: dto.nameFa,
        ...(dto.branchId === undefined ? {} : { branchId: toBigInt(dto.branchId) }),
        glAccountId: toBigInt(dto.glAccountId),
      }),
    };
  }

  @Get('cash-sessions')
  @RequirePermissions('cash.session.read')
  @ApiOperation({ summary: 'شیفت‌های صندوق' })
  async listSessions(
    @Tenant() ctx: TenantContext,
    @Query('cashBoxId') cashBoxId?: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.cash.listSessions(ctx, {
        ...(cashBoxId === undefined ? {} : { cashAccountId: toBigInt(cashBoxId) }),
        ...(status === undefined ? {} : { status }),
      }),
    };
  }

  @Post('cash-sessions')
  @RequirePermissions('cash.session.open')
  @ApiOperation({ summary: 'باز کردن شیفت صندوق' })
  async openSession(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(OpenCashSessionSchema, body);
    return {
      data: await this.cash.openSession(ctx, {
        cashBoxId: toBigInt(dto.cashBoxId),
        openingBalance: toMoney(dto.openingBalance),
      }),
    };
  }

  @Get('cash-sessions/:id')
  @RequirePermissions('cash.session.read')
  @ApiOperation({ summary: 'جزئیات شیفت' })
  async getSession(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.cash.getSession(ctx, toBigInt(id)) };
  }

  @Post('cash-sessions/:id/close')
  @RequirePermissions('cash.session.close')
  @ApiOperation({ summary: 'بستن شیفت با شمارش فیزیکی و ثبت مغایرت' })
  async closeSession(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(CloseCashSessionSchema, body);
    return {
      data: await this.cash.closeSession(ctx, toBigInt(id), {
        countedBalance: toMoney(dto.countedBalance),
        ...(dto.note === undefined ? {} : { note: dto.note }),
      }),
    };
  }

  @Get('cash-transactions')
  @RequirePermissions('cash.transaction.read')
  @ApiOperation({ summary: 'تراکنش‌های صندوق' })
  async listCashTransactions(
    @Tenant() ctx: TenantContext,
    @Query('cashBoxId') cashBoxId?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.cash.listTransactions(ctx, {
        ...(cashBoxId === undefined ? {} : { cashAccountId: toBigInt(cashBoxId) }),
        ...(sessionId === undefined ? {} : { sessionId: toBigInt(sessionId) }),
      }),
    };
  }

  @Post('cash-transactions')
  @RequirePermissions('cash.transaction.create')
  @ApiOperation({ summary: 'ثبت دریافت/پرداخت نقدی' })
  async createCashTransaction(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateCashTransactionSchema, body);
    return {
      data: await this.cash.createTransaction(ctx, {
        cashBoxId: toBigInt(dto.cashBoxId),
        ...(dto.sessionId === undefined ? {} : { sessionId: toBigInt(dto.sessionId) }),
        type: dto.type,
        amount: toMoney(dto.amount),
        date: dto.date,
        ...(dto.partyType === undefined ? {} : { partyType: dto.partyType }),
        ...(dto.partyId === undefined ? {} : { partyId: toBigInt(dto.partyId) }),
        ...(dto.descriptionFa === undefined ? {} : { description: dto.descriptionFa }),
      }),
    };
  }

  @Patch('bank-accounts/:id')
  @RequirePermissions('bank.account.update')
  @ApiOperation({ summary: 'ویرایش حساب بانکی' })
  async updateBankAccount(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { nameFa?: string; glAccountId?: string; active?: boolean },
    @Query('version') version?: string,
  ): Promise<void> {
    await this.bank.updateAccount(
      ctx,
      toBigInt(id),
      {
        ...(body.nameFa === undefined ? {} : { bankName: body.nameFa }),
        ...(body.glAccountId === undefined ? {} : { glAccountId: toBigInt(body.glAccountId) }),
        ...(body.active === undefined ? {} : { isActive: body.active }),
      },
      version === undefined ? 0 : Number(version),
    );
  }

  @Delete('bank-accounts/:id')
  @RequirePermissions('bank.account.delete')
  @ApiOperation({ summary: 'حذف حساب بانکی بدون تراکنش' })
  async deleteBankAccount(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.bank.deleteAccount(ctx, toBigInt(id));
  }
}
