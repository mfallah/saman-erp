/** Partners & shareholders application service (capital, drawings, statements). */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, splitProportionally } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../common/contracts';
import { buildDraft, credit, debit } from '../accounting/posting/types';
import { PostingService } from '../accounting/posting/posting.service';
import { ACCOUNTS } from '../accounting/posting/accounts';
import { asDb, notFound, validation } from '../treasury/persistence/sql-support';
import { PartnersRepository } from './partners.repository';
import type { PartnerAccountRecord, PartnerRecord, PartnerTransactionRecord, ShareholderRecord } from './partners.repository';

export interface CreatePartnerInput {
  readonly code: string;
  readonly type: 'shareholder' | 'investor' | 'channel' | 'supplier' | 'customer' | 'other';
  readonly name: string;
  readonly legalName?: string;
  readonly nationalId?: string;
  readonly economicCode?: string;
  readonly mobile?: string;
  readonly profitSharePercent?: string;
  readonly glAccountId?: bigint;
}

export interface PartnerTransactionInput {
  readonly type: 'capital_increase' | 'capital_decrease' | 'drawing' | 'loan' | 'repayment' | 'profit_share' | 'loss_share' | 'dividend_declared' | 'dividend_paid';
  readonly amount: bigint;
  readonly date: string;
  readonly description?: string;
  readonly paymentId?: bigint;
}

@Injectable()
export class PartnersService {
  constructor(
    private readonly repo: PartnersRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listPartners(
    ctx: TenantContext,
    filter: { readonly type?: string; readonly active?: boolean; readonly search?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PartnerRecord[]> {
    return this.repo.listPartners(ctx.orgId, filter);
  }

  async getPartner(ctx: TenantContext, id: bigint): Promise<PartnerRecord> {
    const partner = await this.repo.findPartner(ctx.orgId, id);
    if (partner === undefined) throw notFound('شریک');
    return partner;
  }

  async createPartner(ctx: TenantContext, input: CreatePartnerInput): Promise<PartnerRecord> {
    if (input.profitSharePercent !== undefined && Number(input.profitSharePercent) > 1) {
      throw validation('درصد سهم سود باید کسری بین صفر و یک باشد.', 'profitSharePercent', 'fraction');
    }
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertPartner(tx, {
        orgId: ctx.orgId,
        code: input.code,
        partnerType: input.type,
        name: input.name,
        ...(input.legalName === undefined ? {} : { legalName: input.legalName }),
        ...(input.nationalId === undefined ? {} : { nationalId: input.nationalId }),
        ...(input.economicCode === undefined ? {} : { economicCode: input.economicCode }),
        ...(input.mobile === undefined ? {} : { mobile: input.mobile }),
        profitSharePercent: input.profitSharePercent ?? '0',
        ...(input.glAccountId === undefined ? {} : { glAccountId: input.glAccountId }),
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'partner.create',
        entityType: 'partner',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, type: input.type, name: input.name },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'partners.partner.created',
        aggregateType: 'partner',
        aggregateId: id,
        payload: { code: input.code, type: input.type },
      });
      const partner = await this.repo.findPartner(ctx.orgId, id, tx);
      if (partner === undefined) throw notFound('شریک');
      return partner;
    });
  }

  async updatePartner(
    ctx: TenantContext,
    id: bigint,
    input: { readonly name?: string; readonly profitSharePercent?: string; readonly isActive?: boolean },
    version: number,
  ): Promise<PartnerRecord> {
    await this.db.begin(async (tx) => {
      await this.repo.updatePartner(tx, ctx.orgId, id, input, version);
      await this.audit.record(asDb(tx), {
        action: 'partner.update',
        entityType: 'partner',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { ...input },
      });
    });
    return this.getPartner(ctx, id);
  }

  async deletePartner(ctx: TenantContext, id: bigint): Promise<void> {
    const accounts = await this.repo.accounts(ctx.orgId, id);
    if (accounts.some((account) => account.currentBalanceAmount !== 0n)) {
      throw new AppError('RULE_VIOLATION', {
        details: [{ rule: 'partner_has_balance' }],
        message: 'شریک دارای مانده حساب است و قابل حذف نیست.',
      });
    }
    await this.db.begin(async (tx) => {
      await this.repo.softDeletePartner(tx, ctx.orgId, id);
      await this.audit.record(asDb(tx), {
        action: 'partner.delete',
        entityType: 'partner',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
    });
  }

  partnerAccounts(ctx: TenantContext, partnerId: bigint): Promise<readonly PartnerAccountRecord[]> {
    return this.repo.accounts(ctx.orgId, partnerId);
  }

  async createPartnerAccount(
    ctx: TenantContext,
    partnerId: bigint,
    input: { readonly type: 'capital' | 'current' | 'profit'; readonly glAccountId: bigint },
  ): Promise<readonly PartnerAccountRecord[]> {
    const accounts = await this.repo.accounts(ctx.orgId, partnerId);
    if (accounts.some((account) => account.accountType === input.type)) {
      throw new AppError('CONFLICT', { message: 'برای این شریک، حساب با این نوع قبلاً ساخته شده است.' });
    }
    await this.db.begin(async (tx) => {
      await this.repo.insertAccount(tx, {
        orgId: ctx.orgId,
        partnerId,
        partnerType: 'shareholder',
        accountType: input.type,
        accountId: input.glAccountId,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'partner.account.create',
        entityType: 'partner_account',
        entityId: partnerId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { type: input.type, glAccountId: input.glAccountId.toString() },
      });
    });
    return this.partnerAccounts(ctx, partnerId);
  }

  transactions(
    ctx: TenantContext,
    partnerId: bigint,
    filter: { readonly type?: string; readonly dateFrom?: string },
  ): Promise<readonly PartnerTransactionRecord[]> {
    void ctx;
    return this.repo.capitalTransactions(partnerId, filter);
  }

  /**
   * Records a partner capital/current movement and posts the matching journal in
   * the same transaction (capital → partner account; dividend → retained equity).
   */
  async createTransaction(
    ctx: TenantContext,
    partnerId: bigint,
    input: PartnerTransactionInput,
  ): Promise<{ readonly id: bigint; readonly journalEntryId: bigint }> {
    if (input.amount <= 0n) throw validation('مبلغ تراکنش باید بزرگ‌تر از صفر باشد.', 'amount', 'positive');
    return this.db.begin(async (tx) => {
      const accounts = await this.repo.accounts(ctx.orgId, partnerId);
      const capital = accounts.find((account) => account.accountType === 'capital') ?? accounts[0];
      if (capital === undefined) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'partner_account_required' }],
          message: 'برای ثبت تراکنش شریک، حساب تفصیلی شریک لازم است.',
        });
      }
      const partnerAccountCode = capital.accountCode;
      const inflow = input.type === 'capital_increase' || input.type === 'loan' || input.type === 'profit_share';
      const legs = inflow
        ? [debit(ACCOUNTS.bank, input.amount, 'دریافت وجه'), credit(partnerAccountCode, input.amount, 'افزایش حساب شریک')]
        : input.type === 'dividend_paid'
          ? [debit(ACCOUNTS.dividendsPayable, input.amount, 'پرداخت سود'), credit(ACCOUNTS.bank, input.amount, 'پرداخت وجه')]
          : input.type === 'dividend_declared'
            ? [debit(ACCOUNTS.retainedEarnings, input.amount, 'توزیع سود'), credit(ACCOUNTS.dividendsPayable, input.amount, 'سود سهام پرداختنی')]
            : [debit(partnerAccountCode, input.amount, 'کاهش حساب شریک'), credit(ACCOUNTS.bank, input.amount, 'پرداخت وجه')];

      const posted = await this.posting.postDraft(
        tx,
        ctx,
        buildDraft(
          {
            eventType: 'profit.distribution.approved',
            entryType: 'adjustment',
            entryDate: input.date,
            descriptionFa: input.description ?? `تراکنش شریک (${input.type})`,
            sourceType: 'partner_capital',
            sourceId: partnerId,
          },
          legs,
        ),
      );
      const id = await this.repo.insertCapitalTransaction(tx, {
        partnerId,
        transactionType: input.type,
        direction: inflow ? 'in' : 'out',
        amount: input.amount,
        transactionDate: input.date,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.paymentId === undefined ? {} : { paymentId: input.paymentId }),
        journalEntryId: posted.journalId,
      });
      await this.audit.record(asDb(tx), {
        action: 'partner.transaction.create',
        entityType: 'partner_capital_transaction',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { type: input.type, amount: input.amount.toString(), journalEntryId: posted.journalId.toString() },
      });
      return { id, journalEntryId: posted.journalId };
    });
  }

  /** Partner statement: capital movements plus the current account balance. */
  async statement(
    ctx: TenantContext,
    partnerId: bigint,
    filter: { readonly dateFrom?: string },
  ): Promise<{ readonly partnerId: bigint; readonly balance: bigint; readonly transactions: readonly PartnerTransactionRecord[] }> {
    const partner = await this.getPartner(ctx, partnerId);
    const accounts = await this.repo.accounts(ctx.orgId, partner.id);
    const balance = accounts.reduce((total, account) => total + account.currentBalanceAmount, 0n);
    const transactions = await this.repo.capitalTransactions(partnerId, filter);
    return { partnerId, balance, transactions };
  }

  /* ------------------------------- shareholders ------------------------------ */

  listShareholders(ctx: TenantContext, filter: { readonly active?: boolean }): Promise<readonly ShareholderRecord[]> {
    return this.repo.listShareholders(ctx.orgId, filter);
  }

  async createShareholder(
    ctx: TenantContext,
    input: { readonly code: string; readonly name: string; readonly shareholderType: string; readonly sharePercent: string; readonly nationalId?: string },
  ): Promise<readonly ShareholderRecord[]> {
    const current = await this.repo.totalOwnership(ctx.orgId);
    const next = current + percentToScaled(input.sharePercent);
    if (next > 1_000_000n + 1n) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'sharePercent', rule: 'sum_over_100' }],
        message: 'جمع درصد سهام سهامداران نمی‌تواند بیشتر از ۱۰۰٪ باشد.',
      });
    }
    await this.db.begin(async (tx) => {
      const id = await this.repo.insertShareholder(tx, {
        orgId: ctx.orgId,
        code: input.code,
        name: input.name,
        shareholderType: input.shareholderType,
        ownershipPercent: input.sharePercent,
        ...(input.nationalId === undefined ? {} : { nationalId: input.nationalId }),
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'shareholder.create',
        entityType: 'shareholder',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, sharePercent: input.sharePercent },
      });
    });
    return this.listShareholders(ctx, {});
  }

  /** Share adjustment: ownership must stay at exactly 100% and effective-dated. */
  async adjustShare(ctx: TenantContext, id: bigint, input: { readonly sharePercent: string; readonly effectiveDate: string; readonly reason: string }): Promise<readonly ShareholderRecord[]> {
    const shareholders = await this.repo.listShareholders(ctx.orgId, {});
    const target = shareholders.find((shareholder) => shareholder.id === id);
    if (target === undefined) throw notFound('سهامدار');
    const others = shareholders
      .filter((shareholder) => shareholder.id !== id)
      .reduce((total, shareholder) => total + percentToScaled(shareholder.ownershipPercent), 0n);
    const total = others + percentToScaled(input.sharePercent);
    if (total !== 1_000_000n) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'sharePercent', rule: 'sum_must_equal_100', params: { sum: (Number(total) / 1_000_000).toFixed(6) } }],
        message: 'جمع درصد سهام همه سهامداران باید دقیقاً ۱۰۰٪ باشد.',
      });
    }
    await this.db.begin(async (tx) => {
      await this.repo.updateShareholderOwnership(tx, ctx.orgId, id, input.sharePercent, target.version);
      await this.audit.record(asDb(tx), {
        action: 'shareholder.share.adjust',
        entityType: 'shareholder',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { ownershipPercent: target.ownershipPercent },
        after: { ownershipPercent: input.sharePercent, effectiveDate: input.effectiveDate, reason: input.reason },
      });
    });
    return this.listShareholders(ctx, {});
  }

  async createShareholderTransaction(
    ctx: TenantContext,
    shareholderId: bigint,
    input: { readonly type: 'capital_in' | 'capital_out' | 'dividend' | 'adjustment'; readonly amount: bigint; readonly date: string; readonly description?: string },
  ): Promise<{ readonly id: bigint }> {
    if (input.amount <= 0n) throw validation('مبلغ تراکنش باید بزرگ‌تر از صفر باشد.', 'amount', 'positive');
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertShareholderTransaction(tx, {
        shareholderId,
        transactionType: input.type === 'dividend' ? 'dividend_paid' : input.type === 'capital_in' ? 'capital_increase' : input.type === 'capital_out' ? 'capital_decrease' : 'adjustment',
        direction: input.type === 'capital_out' || input.type === 'dividend' ? 'out' : 'in',
        amount: input.amount,
        transactionDate: input.date,
        ...(input.description === undefined ? {} : { description: input.description }),
      });
      await this.audit.record(asDb(tx), {
        action: 'shareholder.transaction.create',
        entityType: 'shareholder_transaction',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { type: input.type, amount: input.amount.toString() },
      });
      return { id };
    });
  }
}

/** Verifies a distribution sum helper exported for tests/callers. */
export function splitByOwnership(amount: bigint, percents: readonly string[]): readonly bigint[] {
  return splitProportionally(amount, percents.map((percent) => percentToScaled(percent)));
}

function percentToScaled(percent: string): bigint {
  const [whole = '0', fraction = ''] = percent.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}
