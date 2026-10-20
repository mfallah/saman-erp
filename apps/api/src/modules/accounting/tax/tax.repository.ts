import type { SqlSession } from '../persistence/sql-support';
/** Tax repository — `erp.tax_rates`, `erp.tax_documents` (+ per-rate lines). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { conflict, notFound } from '../persistence/sql-support';

export interface TaxRateRecord {
  readonly id: bigint;
  readonly code: string;
  readonly nameFa: string;
  readonly taxType: string;
  /** Fraction (`0.100000` = 10%). */
  readonly ratePercent: string;
  readonly glAccountId: bigint;
  readonly isRecoverable: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface TaxDocumentRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly documentNo: string;
  readonly documentType: string;
  readonly documentKind: string;
  readonly issueDate: string;
  readonly taxableAmount: bigint;
  readonly taxAmount: bigint;
  readonly totalAmount: bigint;
  readonly status: string;
  readonly customerInvoiceId: bigint | null;
  readonly supplierInvoiceId: bigint | null;
  readonly journalEntryId: bigint | null;
  readonly originalDocumentId: bigint | null;
}

interface RateRow {
  id: string;
  code: string;
  name_fa: string;
  tax_type: string;
  rate_percent: string;
  gl_account_id: string;
  is_recoverable: boolean;
  effective_from: string;
  effective_to: string | null;
  is_default: boolean;
  is_active: boolean;
}

interface DocumentRow {
  id: string;
  public_id: string;
  document_no: string;
  document_type: string;
  document_kind: string;
  issue_date: string;
  taxable_amount: string;
  tax_amount: string;
  total_amount: string;
  status: string;
  customer_invoice_id: string | null;
  supplier_invoice_id: string | null;
  journal_entry_id: string | null;
  original_document_id: string | null;
}

function toRate(row: RateRow): TaxRateRecord {
  return {
    id: BigInt(row.id),
    code: row.code,
    nameFa: row.name_fa,
    taxType: row.tax_type,
    ratePercent: row.rate_percent,
    glAccountId: BigInt(row.gl_account_id),
    isRecoverable: row.is_recoverable,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isDefault: row.is_default,
    isActive: row.is_active,
  };
}

function toDocument(row: DocumentRow): TaxDocumentRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    documentNo: row.document_no,
    documentType: row.document_type,
    documentKind: row.document_kind,
    issueDate: row.issue_date,
    taxableAmount: BigInt(row.taxable_amount),
    taxAmount: BigInt(row.tax_amount),
    totalAmount: BigInt(row.total_amount),
    status: row.status,
    customerInvoiceId: row.customer_invoice_id === null ? null : BigInt(row.customer_invoice_id),
    supplierInvoiceId: row.supplier_invoice_id === null ? null : BigInt(row.supplier_invoice_id),
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
    originalDocumentId: row.original_document_id === null ? null : BigInt(row.original_document_id),
  };
}

const RATE_COLUMNS = `id::text as id, code, name_fa, tax_type, rate_percent::text as rate_percent,
  gl_account_id::text as gl_account_id, is_recoverable, effective_from::text as effective_from,
  effective_to::text as effective_to, is_default, is_active`;

const DOCUMENT_COLUMNS = `id::text as id, public_id::text as public_id, document_no, document_type,
  document_kind, issue_date::text as issue_date, taxable_amount::text as taxable_amount,
  tax_amount::text as tax_amount, total_amount::text as total_amount, status,
  customer_invoice_id::text as customer_invoice_id, supplier_invoice_id::text as supplier_invoice_id,
  journal_entry_id::text as journal_entry_id, original_document_id::text as original_document_id`;

@Injectable()
export class TaxRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listRates(orgId: bigint, filter: { readonly active?: boolean; readonly type?: string }): Promise<readonly TaxRateRecord[]> {
    const rows = await this.db<RateRow[]>`
      select ${this.db.unsafe(RATE_COLUMNS)}
        from erp.tax_rates
       where organization_id = ${orgId.toString()}
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
         and (${filter.type ?? null}::text is null or tax_type = ${filter.type ?? null})
       order by effective_from desc, code`;
    return rows.map(toRate);
  }

  async findRate(orgId: bigint, id: bigint): Promise<TaxRateRecord | undefined> {
    const rows = await this.db<RateRow[]>`
      select ${this.db.unsafe(RATE_COLUMNS)}
        from erp.tax_rates where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toRate(row);
  }

  async insertRate(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly nameFa: string;
      readonly taxType: string;
      readonly ratePercent: string;
      readonly glAccountId: bigint;
      readonly effectiveFrom: string;
      readonly effectiveTo?: string;
      readonly isDefault: boolean;
      readonly isRecoverable: boolean;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const overlapping = await tx<{ count: string }[]>`
      select count(*)::text as count from erp.tax_rates
       where organization_id = ${input.orgId.toString()}
         and tax_type = ${input.taxType}
         and daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]')
             && daterange(${input.effectiveFrom}::date, coalesce(${input.effectiveTo ?? null}::date, 'infinity'::date), '[]')`;
    if (Number(overlapping[0]?.count ?? '0') > 0) {
      throw conflict('بازه اعتبار نرخ مالیات با نرخ دیگری همپوشانی دارد.');
    }
    if (input.isDefault) {
      if (input.taxType !== 'vat') {
        throw conflict('تنها نرخ مالیات بر ارزش افزوده می‌تواند پیش‌فرض باشد.');
      }
      await tx`
        update erp.tax_rates set is_default = false
         where organization_id = ${input.orgId.toString()} and is_default`;
    }
    const rows = await tx<{ id: string }[]>`
      insert into erp.tax_rates
        (organization_id, code, name_fa, tax_type, rate_percent, gl_account_id, is_recoverable,
         effective_from, effective_to, is_default, is_active, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.nameFa}, ${input.taxType},
         ${input.ratePercent}, ${input.glAccountId.toString()}, ${input.isRecoverable},
         ${input.effectiveFrom}, ${input.effectiveTo ?? null}, ${input.isDefault}, true,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد نرخ مالیات انجام نشد.');
    return BigInt(id);
  }

  async updateRate(
    tx: SqlSession,
    orgId: bigint,
    id: bigint,
    input: { readonly ratePercent?: string; readonly effectiveTo?: string; readonly isActive?: boolean },
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.tax_rates
         set rate_percent = coalesce(${input.ratePercent ?? null}::numeric, rate_percent),
             effective_to = coalesce(${input.effectiveTo ?? null}::date, effective_to),
             is_active = coalesce(${input.isActive ?? null}, is_active),
             version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()}
      returning id::text as id`;
    if (rows.length === 0) throw notFound('نرخ مالیات');
  }

  async deleteRate(tx: SqlSession, orgId: bigint, id: bigint): Promise<void> {
    const used = await tx<{ count: string }[]>`
      select count(*)::text as count from erp.tax_document_lines where tax_rate_id = ${id.toString()}`;
    if (Number(used[0]?.count ?? '0') > 0) {
      throw conflict('نرخ مالیات در اسناد استفاده شده و قابل حذف نیست.');
    }
    await tx`delete from erp.tax_rates where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
  }

  async listDocuments(
    orgId: bigint,
    filter: { readonly type?: string; readonly status?: string; readonly issueFrom?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly TaxDocumentRecord[]> {
    const rows = await this.db<DocumentRow[]>`
      select ${this.db.unsafe(DOCUMENT_COLUMNS)}
        from erp.tax_documents
       where organization_id = ${orgId.toString()}
         and (${filter.type ?? null}::text is null or document_type = ${filter.type ?? null})
         and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
         and (${filter.issueFrom ?? null}::date is null or issue_date >= ${filter.issueFrom ?? null}::date)
       order by issue_date desc, id desc
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map(toDocument);
  }

  async findDocument(orgId: bigint, id: bigint): Promise<TaxDocumentRecord | undefined> {
    const rows = await this.db<DocumentRow[]>`
      select ${this.db.unsafe(DOCUMENT_COLUMNS)}
        from erp.tax_documents where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toDocument(row);
  }

  async insertDocument(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly documentNo: string;
      readonly documentType: string;
      readonly documentKind: string;
      readonly issueDate: string;
      readonly taxableAmount: bigint;
      readonly taxAmount: bigint;
      readonly totalAmount: bigint;
      readonly customerInvoiceId?: bigint;
      readonly supplierInvoiceId?: bigint;
      readonly originalDocumentId?: bigint;
      readonly partyType?: string;
      readonly partyId?: bigint;
      readonly journalEntryId?: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.tax_documents
        (organization_id, document_no, document_type, document_kind, issue_date, taxable_amount,
         tax_amount, total_amount, status, customer_invoice_id, supplier_invoice_id,
         original_document_id, party_type, party_id, journal_entry_id, created_by)
      values
        (${input.orgId.toString()}, ${input.documentNo}, ${input.documentType}, ${input.documentKind},
         ${input.issueDate}, ${input.taxableAmount.toString()}, ${input.taxAmount.toString()},
         ${input.totalAmount.toString()}, 'draft',
         ${input.customerInvoiceId === undefined ? null : input.customerInvoiceId.toString()}::bigint,
         ${input.supplierInvoiceId === undefined ? null : input.supplierInvoiceId.toString()}::bigint,
         ${input.originalDocumentId === undefined ? null : input.originalDocumentId.toString()}::bigint,
         ${input.partyType ?? null},
         ${input.partyId === undefined ? null : input.partyId.toString()}::bigint,
         ${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد سند مالیاتی انجام نشد.');
    return BigInt(id);
  }

  async insertDocumentLine(
    tx: SqlSession,
    input: {
      readonly taxDocumentId: bigint;
      readonly taxRateId: bigint;
      readonly ratePercent: string;
      readonly taxableAmount: bigint;
      readonly taxAmount: bigint;
    },
  ): Promise<void> {
    await tx`
      insert into erp.tax_document_lines
        (tax_document_id, tax_rate_id, rate_percent, taxable_amount, tax_amount)
      values
        (${input.taxDocumentId.toString()}, ${input.taxRateId.toString()}, ${input.ratePercent},
         ${input.taxableAmount.toString()}, ${input.taxAmount.toString()})`;
  }

  async setStatus(tx: SqlSession, id: bigint, status: string, actorId: bigint | null): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.tax_documents set status = ${status}, version = version + 1
       where id = ${id.toString()} and status <> ${status}
      returning id::text as id`;
    void actorId;
    if (rows.length === 0) throw conflict('وضعیت سند مالیاتی قابل تغییر نیست.');
  }

  async linkJournal(tx: SqlSession, id: bigint, journalEntryId: bigint): Promise<void> {
    await tx`
      update erp.tax_documents set journal_entry_id = ${journalEntryId.toString()}::bigint, version = version + 1
       where id = ${id.toString()}`;
  }
}
