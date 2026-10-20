import { asDb } from '../persistence/sql-support';
/** Tax rates & tax documents (`DATA-MODEL §2.12`; مؤدیان export is out of scope). */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, applyRate } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import type { JournalRepository } from '../journal/journal.repository';
import type { TaxRepository } from './tax.repository';
import type { TaxDocumentRecord, TaxRateRecord } from './tax.repository';

export interface CreateTaxRateInput {
  readonly code: string;
  readonly nameFa: string;
  readonly taxType: 'vat' | 'withholding' | 'income' | 'excise' | 'duty' | 'exempt';
  /** Fraction per contract (`0.10` = 10%), never `10`. */
  readonly ratePercent: string;
  readonly glAccountId: bigint;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly isDefault?: boolean;
  readonly isRecoverable?: boolean;
}

export interface CreateTaxDocumentInput {
  readonly documentType: string;
  readonly documentKind?: 'original' | 'credit_note' | 'debit_note';
  readonly taxableAmount: bigint;
  readonly ratePercent: string;
  readonly customerInvoiceId?: bigint;
  readonly supplierInvoiceId?: bigint;
  readonly originalDocumentId?: bigint;
  readonly partyType?: string;
  readonly partyId?: bigint;
  readonly issueDate: string;
  readonly taxRateId?: bigint;
}

@Injectable()
export class TaxService {
  constructor(
    private readonly repo: TaxRepository,
    private readonly journals: JournalRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listRates(ctx: TenantContext, filter: { readonly active?: boolean; readonly type?: string }): Promise<readonly TaxRateRecord[]> {
    return this.repo.listRates(ctx.orgId, filter);
  }

  async createRate(ctx: TenantContext, input: CreateTaxRateInput): Promise<TaxRateRecord> {
    const rate = Number(input.ratePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'ratePercent', rule: 'fraction_between_0_and_1' }],
        message: 'نرخ مالیات باید به صورت کسر بین صفر و یک وارد شود (۰.۱۰ یعنی ۱۰٪).',
      });
    }
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertRate(tx, {
        orgId: ctx.orgId,
        code: input.code,
        nameFa: input.nameFa,
        taxType: input.taxType,
        ratePercent: input.ratePercent,
        glAccountId: input.glAccountId,
        effectiveFrom: input.effectiveFrom,
        ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
        isDefault: input.isDefault ?? false,
        isRecoverable: input.isRecoverable ?? true,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_rate.create',
        entityType: 'tax_rate',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, ratePercent: input.ratePercent, taxType: input.taxType },
      });
      const created = await this.repo.findRate(ctx.orgId, id);
      if (created === undefined) throw new AppError('NOT_FOUND', { message: 'نرخ مالیات یافت نشد.' });
      return created;
    });
  }

  async updateRate(
    ctx: TenantContext,
    id: bigint,
    input: { readonly ratePercent?: string; readonly effectiveTo?: string; readonly isActive?: boolean },
  ): Promise<TaxRateRecord> {
    const current = await this.repo.findRate(ctx.orgId, id);
    if (current === undefined) throw new AppError('NOT_FOUND', { message: 'نرخ مالیات یافت نشد.' });
    await this.db.begin(async (tx) => {
      await this.repo.updateRate(tx, ctx.orgId, id, input);
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_rate.update',
        entityType: 'tax_rate',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { ratePercent: current.ratePercent, isActive: current.isActive },
        after: { ...input },
      });
    });
    const updated = await this.repo.findRate(ctx.orgId, id);
    if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'نرخ مالیات یافت نشد.' });
    return updated;
  }

  async deleteRate(ctx: TenantContext, id: bigint): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.repo.deleteRate(tx, ctx.orgId, id);
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_rate.delete',
        entityType: 'tax_rate',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
    });
  }

  listDocuments(
    ctx: TenantContext,
    filter: { readonly type?: string; readonly status?: string; readonly issueFrom?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly TaxDocumentRecord[]> {
    return this.repo.listDocuments(ctx.orgId, filter);
  }

  async getDocument(ctx: TenantContext, id: bigint): Promise<TaxDocumentRecord> {
    const document = await this.repo.findDocument(ctx.orgId, id);
    if (document === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
    return document;
  }

  /** Draft document with computed tax, per-rate line and a temporary number. */
  async createDocument(ctx: TenantContext, input: CreateTaxDocumentInput): Promise<TaxDocumentRecord> {
    const taxAmount = applyRate(input.taxableAmount, input.ratePercent);
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertDocument(tx, {
        orgId: ctx.orgId,
        documentNo: `DRAFT-${Date.now()}`,
        documentType: input.documentType,
        documentKind: input.documentKind ?? 'original',
        issueDate: input.issueDate,
        taxableAmount: input.taxableAmount,
        taxAmount,
        totalAmount: input.taxableAmount + taxAmount,
        ...(input.customerInvoiceId === undefined ? {} : { customerInvoiceId: input.customerInvoiceId }),
        ...(input.supplierInvoiceId === undefined ? {} : { supplierInvoiceId: input.supplierInvoiceId }),
        ...(input.originalDocumentId === undefined ? {} : { originalDocumentId: input.originalDocumentId }),
        ...(input.partyType === undefined ? {} : { partyType: input.partyType }),
        ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
        createdBy: ctx.actorId,
      });
      if (input.taxRateId !== undefined) {
        await this.repo.insertDocumentLine(tx, {
          taxDocumentId: id,
          taxRateId: input.taxRateId,
          ratePercent: input.ratePercent,
          taxableAmount: input.taxableAmount,
          taxAmount,
        });
      }
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_document.create',
        entityType: 'tax_document',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { documentType: input.documentType, taxAmount: taxAmount.toString() },
      });
      const created = await this.repo.findDocument(ctx.orgId, id);
      if (created === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
      return created;
    });
  }

  /** Issues the document with a gap-free number (`numbering_sequences`). */
  async issueDocument(ctx: TenantContext, id: bigint, issueDate?: string): Promise<TaxDocumentRecord> {
    return this.db.begin(async (tx) => {
      const doc = await this.repo.findDocument(ctx.orgId, id);
      if (doc === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
      if (doc.status !== 'draft') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تنها سند پیش‌نویس قابل صدور است.' });
      }
      const numbering = await tx<{ next?: string }[]>`
        select (
          select y.id::text from erp.fiscal_years y
           where y.organization_id = ${ctx.orgId.toString()}
             and ${issueDate ?? doc.issueDate}::date between y.start_date and y.end_date
           limit 1
        ) as next`;
      const yearId = numbering[0]?.next;
      if (yearId === undefined) {
        throw new AppError('NOT_FOUND', { message: 'سال مالی برای تاریخ صدور یافت نشد.' });
      }
      const documentNo = await this.journals.allocateEntryNo(tx, ctx.orgId, BigInt(yearId), 'TAX', 'TAX');
      await tx`
        update erp.tax_documents
           set document_no = ${documentNo}, status = 'issued',
               issue_date = coalesce(${issueDate ?? null}::date, issue_date), version = version + 1
         where id = ${id.toString()}`;
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_document.issue',
        entityType: 'tax_document',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { documentNo },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.tax_document.issued',
        aggregateType: 'tax_document',
        aggregateId: id,
        payload: { documentNo, documentType: doc.documentType },
      });
      const issued = await this.repo.findDocument(ctx.orgId, id);
      if (issued === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
      return issued;
    });
  }

  /** Void = issue a replacing credit note (never delete an issued document). */
  async voidDocument(ctx: TenantContext, id: bigint, reason: string): Promise<TaxDocumentRecord> {
    return this.db.begin(async (tx) => {
      const doc = await this.repo.findDocument(ctx.orgId, id);
      if (doc === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
      if (doc.status !== 'issued') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تنها سند صادرشده قابل ابطال است.' });
      }
      const replacementId = await this.repo.insertDocument(tx, {
        orgId: ctx.orgId,
        documentNo: `CN-${doc.documentNo}`,
        documentType: doc.documentType,
        documentKind: 'credit_note',
        issueDate: new Date().toISOString().slice(0, 10),
        taxableAmount: -doc.taxableAmount,
        taxAmount: -doc.taxAmount,
        totalAmount: -doc.totalAmount,
        originalDocumentId: doc.id,
        ...(doc.customerInvoiceId === null ? {} : { customerInvoiceId: doc.customerInvoiceId }),
        ...(doc.supplierInvoiceId === null ? {} : { supplierInvoiceId: doc.supplierInvoiceId }),
        createdBy: ctx.actorId,
      });
      await this.repo.setStatus(tx, id, 'voided', ctx.actorId);
      await this.repo.setStatus(tx, replacementId, 'issued', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.tax_document.void',
        entityType: 'tax_document',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { reason, creditNoteId: replacementId.toString() },
      });
      const replacement = await this.repo.findDocument(ctx.orgId, replacementId);
      if (replacement === undefined) throw new AppError('NOT_FOUND', { message: 'سند مالیاتی یافت نشد.' });
      return replacement;
    });
  }

  /** مؤدیان-compatible export payload (submission itself is out of scope). */
  async exportDocument(ctx: TenantContext, id: bigint, format: 'json' | 'xml'): Promise<{ payload: string; contentType: string }> {
    const doc = await this.getDocument(ctx, id);
    const body = {
      documentNo: doc.documentNo,
      documentType: doc.documentType,
      documentKind: doc.documentKind,
      issueDate: doc.issueDate,
      taxableAmount: doc.taxableAmount.toString(),
      taxAmount: doc.taxAmount.toString(),
      totalAmount: doc.totalAmount.toString(),
    };
    if (format === 'json') {
      return { payload: JSON.stringify(body), contentType: 'application/json' };
    }
    const escape = (value: string): string => value.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char));
    const xml = `<?xml version="1.0" encoding="UTF-8"?><TaxDocument>${Object.entries(body)
      .map(([key, value]) => `<${key}>${escape(value)}</${key}>`)
      .join('')}</TaxDocument>`;
    return { payload: xml, contentType: 'application/xml' };
  }
}
