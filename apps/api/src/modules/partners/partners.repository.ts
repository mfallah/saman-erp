/**
 * Partners repository: `erp.partners`, `erp.partner_accounts`, `erp.partner_shares`,
 * `erp.partner_capital_transactions`, `erp.shareholders`, `erp.shareholder_transactions`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';
import type { SqlSession } from '../accounting/persistence/sql-support';
import { conflict, notFound } from '../accounting/persistence/sql-support';

export interface PartnerRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly code: string;
  readonly partnerType: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly nationalId: string | null;
  readonly economicCode: string | null;
  readonly mobile: string | null;
  readonly profitSharePercent: string;
  readonly glAccountId: bigint | null;
  readonly isActive: boolean;
  readonly version: number;
}

export interface PartnerAccountRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly partnerId: bigint | null;
  readonly partnerType: string;
  readonly accountType: string;
  readonly accountId: bigint;
  readonly accountCode: string;
  readonly currentBalanceAmount: bigint;
  readonly isActive: boolean;
  readonly version: number;
}

export interface PartnerTransactionRecord {
  readonly id: bigint;
  readonly partnerId: bigint;
  readonly transactionType: string;
  readonly direction: string;
  readonly amount: bigint;
  readonly transactionDate: string;
  readonly journalEntryId: bigint | null;
  readonly description: string | null;
}

export interface ShareholderRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly code: string;
  readonly name: string;
  readonly shareholderType: string;
  readonly ownershipPercent: string;
  readonly shareCount: string;
  readonly capitalValueAmount: bigint;
  readonly isActive: boolean;
  readonly version: number;
}

export interface PartnerShareRecord {
  readonly id: bigint;
  readonly partnerId: bigint;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly shareCount: string;
  readonly ownershipPercent: string;
  readonly capitalValueAmount: bigint;
}

const PARTNER_COLUMNS = `id::text as id, public_id::text as public_id, code, partner_type, name,
  legal_name, national_id, economic_code, mobile, profit_share_percent::text as profit_share_percent,
  gl_account_id::text as gl_account_id, is_active, version`;

@Injectable()
export class PartnersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listPartners(
    orgId: bigint,
    filter: { readonly type?: string; readonly active?: boolean; readonly search?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PartnerRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; code: string; partner_type: string; name: string;
      legal_name: string | null; national_id: string | null; economic_code: string | null;
      mobile: string | null; profit_share_percent: string; gl_account_id: string | null;
      is_active: boolean; version: number;
    }[]>`
      select ${this.db.unsafe(PARTNER_COLUMNS)}
        from erp.partners
       where organization_id = ${orgId.toString()} and deleted_at is null
         and (${filter.type ?? null}::text is null or partner_type = ${filter.type ?? null})
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
         and (${filter.search ?? null}::text is null or name ilike '%' || ${filter.search ?? ''} || '%' or code ilike '%' || ${filter.search ?? ''} || '%')
       order by code
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      partnerType: row.partner_type,
      name: row.name,
      legalName: row.legal_name,
      nationalId: row.national_id,
      economicCode: row.economic_code,
      mobile: row.mobile,
      profitSharePercent: row.profit_share_percent,
      glAccountId: row.gl_account_id === null ? null : BigInt(row.gl_account_id),
      isActive: row.is_active,
      version: row.version,
    }));
  }

  async findPartner(orgId: bigint, id: bigint, tx?: SqlSession): Promise<PartnerRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<{
      id: string; public_id: string; code: string; partner_type: string; name: string;
      legal_name: string | null; national_id: string | null; economic_code: string | null;
      mobile: string | null; profit_share_percent: string; gl_account_id: string | null;
      is_active: boolean; version: number;
    }[]>`
      select ${client.unsafe(PARTNER_COLUMNS)}
        from erp.partners where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      partnerType: row.partner_type,
      name: row.name,
      legalName: row.legal_name,
      nationalId: row.national_id,
      economicCode: row.economic_code,
      mobile: row.mobile,
      profitSharePercent: row.profit_share_percent,
      glAccountId: row.gl_account_id === null ? null : BigInt(row.gl_account_id),
      isActive: row.is_active,
      version: row.version,
    };
  }

  async insertPartner(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly partnerType: string;
      readonly name: string;
      readonly legalName?: string;
      readonly nationalId?: string;
      readonly economicCode?: string;
      readonly mobile?: string;
      readonly profitSharePercent: string;
      readonly glAccountId?: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.partners
        (organization_id, code, partner_type, name, legal_name, national_id, economic_code, mobile,
         profit_share_percent, gl_account_id, is_active, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.partnerType}, ${input.name},
         ${input.legalName ?? null}, ${input.nationalId ?? null}, ${input.economicCode ?? null},
         ${input.mobile ?? null}, ${input.profitSharePercent},
         ${input.glAccountId === undefined ? null : input.glAccountId.toString()}::bigint, true,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد شریک انجام نشد.');
    return BigInt(id);
  }

  async updatePartner(
    tx: SqlSession,
    orgId: bigint,
    id: bigint,
    input: { readonly name?: string; readonly profitSharePercent?: string; readonly isActive?: boolean },
    expectedVersion: number,
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.partners
         set name = coalesce(${input.name ?? null}, name),
             profit_share_percent = coalesce(${input.profitSharePercent ?? null}::numeric, profit_share_percent),
             is_active = coalesce(${input.isActive ?? null}, is_active),
             version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and version = ${expectedVersion}
      returning id::text as id`;
    if (rows.length === 0) throw conflict('نسخه شریک تغییر کرده است.');
  }

  async softDeletePartner(tx: SqlSession, orgId: bigint, id: bigint): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.partners set deleted_at = now(), is_active = false, version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and deleted_at is null
      returning id::text as id`;
    if (rows.length === 0) throw notFound('شریک');
  }

  async accounts(orgId: bigint, partnerId?: bigint): Promise<readonly PartnerAccountRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; partner_id: string | null; partner_type: string;
      account_type: string; account_id: string; code: string;
      current_balance_amount: string; is_active: boolean; version: number;
    }[]>`
      select pa.id::text as id, pa.public_id::text as public_id, pa.partner_id::text as partner_id,
             pa.partner_type, pa.account_type, pa.account_id::text as account_id, a.code,
             pa.current_balance_amount::text as current_balance_amount, pa.is_active, pa.version
        from erp.partner_accounts pa
        join erp.chart_of_accounts a on a.id = pa.account_id
       where pa.organization_id = ${orgId.toString()}
         and (${partnerId === undefined ? null : partnerId.toString()}::bigint is null or pa.partner_id = ${partnerId === undefined ? null : partnerId.toString()}::bigint)
       order by pa.id`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      partnerId: row.partner_id === null ? null : BigInt(row.partner_id),
      partnerType: row.partner_type,
      accountType: row.account_type,
      accountId: BigInt(row.account_id),
      accountCode: row.code,
      currentBalanceAmount: BigInt(row.current_balance_amount),
      isActive: row.is_active,
      version: row.version,
    }));
  }

  async insertAccount(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly partnerId: bigint;
      readonly partnerType: string;
      readonly accountType: string;
      readonly accountId: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.partner_accounts
        (organization_id, partner_type, partner_id, account_type, account_id, created_by)
      values
        (${input.orgId.toString()}, ${input.partnerType}, ${input.partnerId.toString()},
         ${input.accountType}, ${input.accountId.toString()},
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد حساب شریک انجام نشد.');
    return BigInt(id);
  }

  async findAccount(orgId: bigint, id: bigint): Promise<PartnerAccountRecord | undefined> {
    const accounts = await this.accounts(orgId, 0n);
    return accounts.find((account) => account.id === id);
  }

  async shares(partnerId: bigint, tx?: SqlSession): Promise<readonly PartnerShareRecord[]> {
    const client = tx ?? this.db;
    const rows = await client<{
      id: string; partner_id: string; effective_from: string; effective_to: string | null;
      share_count: string; ownership_percent: string; capital_value_amount: string;
    }[]>`
      select id::text as id, partner_id::text as partner_id, effective_from::text as effective_from,
             effective_to::text as effective_to, share_count::text as share_count,
             ownership_percent::text as ownership_percent,
             capital_value_amount::text as capital_value_amount
        from erp.partner_shares where partner_id = ${partnerId.toString()}
       order by effective_from`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      partnerId: BigInt(row.partner_id),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      shareCount: row.share_count,
      ownershipPercent: row.ownership_percent,
      capitalValueAmount: BigInt(row.capital_value_amount),
    }));
  }

  async insertShare(
    tx: SqlSession,
    input: {
      readonly partnerId: bigint;
      readonly effectiveFrom: string;
      readonly shareCount: string;
      readonly ownershipPercent: string;
      readonly capitalValueAmount: bigint;
      readonly reason?: string;
      readonly journalEntryId?: bigint;
    },
  ): Promise<void> {
    await tx`
      insert into erp.partner_shares
        (partner_id, effective_from, share_count, ownership_percent, capital_value_amount, reason, journal_entry_id)
      values
        (${input.partnerId.toString()}, ${input.effectiveFrom}, ${input.shareCount},
         ${input.ownershipPercent}, ${input.capitalValueAmount.toString()}, ${input.reason ?? null},
         ${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint)`;
  }

  async insertCapitalTransaction(
    tx: SqlSession,
    input: {
      readonly partnerId: bigint;
      readonly transactionType: string;
      readonly direction: 'in' | 'out';
      readonly amount: bigint;
      readonly transactionDate: string;
      readonly description?: string;
      readonly paymentId?: bigint;
      readonly journalEntryId?: bigint;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.partner_capital_transactions
        (partner_id, transaction_type, direction, amount, transaction_date, description, payment_id, journal_entry_id)
      values
        (${input.partnerId.toString()}, ${input.transactionType}, ${input.direction},
         ${input.amount.toString()}, ${input.transactionDate}, ${input.description ?? null},
         ${input.paymentId === undefined ? null : input.paymentId.toString()}::bigint,
         ${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت تراکنش شریک انجام نشد.');
    return BigInt(id);
  }

  async capitalTransactions(
    partnerId: bigint,
    filter: { readonly type?: string; readonly dateFrom?: string },
  ): Promise<readonly PartnerTransactionRecord[]> {
    const rows = await this.db<{
      id: string; partner_id: string; transaction_type: string; direction: string;
      amount: string; transaction_date: string; journal_entry_id: string | null; description: string | null;
    }[]>`
      select id::text as id, partner_id::text as partner_id, transaction_type, direction,
             amount::text as amount, transaction_date::text as transaction_date,
             journal_entry_id::text as journal_entry_id, description
        from erp.partner_capital_transactions
       where partner_id = ${partnerId.toString()}
         and (${filter.type ?? null}::text is null or transaction_type = ${filter.type ?? null})
         and (${filter.dateFrom ?? null}::date is null or transaction_date >= ${filter.dateFrom ?? null}::date)
       order by transaction_date desc, id desc`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      partnerId: BigInt(row.partner_id),
      transactionType: row.transaction_type,
      direction: row.direction,
      amount: BigInt(row.amount),
      transactionDate: row.transaction_date,
      journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
      description: row.description,
    }));
  }

  /* ------------------------------- shareholders ------------------------------ */

  async listShareholders(orgId: bigint, filter: { readonly active?: boolean }): Promise<readonly ShareholderRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; code: string; name: string; shareholder_type: string;
      ownership_percent: string; share_count: string; capital_value_amount: string;
      is_active: boolean; version: number;
    }[]>`
      select id::text as id, public_id::text as public_id, code, name, shareholder_type,
             ownership_percent::text as ownership_percent, share_count::text as share_count,
             capital_value_amount::text as capital_value_amount, is_active, version
        from erp.shareholders
       where organization_id = ${orgId.toString()} and deleted_at is null
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
       order by code`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      name: row.name,
      shareholderType: row.shareholder_type,
      ownershipPercent: row.ownership_percent,
      shareCount: row.share_count,
      capitalValueAmount: BigInt(row.capital_value_amount),
      isActive: row.is_active,
      version: row.version,
    }));
  }

  async totalOwnership(orgId: bigint, excludeId?: bigint): Promise<bigint> {
    const rows = await this.db<{ total: string }[]>`
      select coalesce(round(sum(ownership_percent) * 1000000), 0)::bigint::text as total
        from erp.shareholders
       where organization_id = ${orgId.toString()} and deleted_at is null and is_active
         and (${excludeId === undefined ? null : excludeId.toString()}::bigint is null or id <> ${excludeId === undefined ? null : excludeId.toString()}::bigint)`;
    return BigInt(rows[0]?.total ?? '0');
  }

  async insertShareholder(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly name: string;
      readonly shareholderType: string;
      readonly ownershipPercent: string;
      readonly nationalId?: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.shareholders
        (organization_id, code, name, shareholder_type, ownership_percent, national_id, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.name}, ${input.shareholderType},
         ${input.ownershipPercent}, ${input.nationalId ?? null},
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد سهامدار انجام نشد.');
    return BigInt(id);
  }

  async updateShareholderOwnership(tx: SqlSession, orgId: bigint, id: bigint, percent: string, expectedVersion: number): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.shareholders set ownership_percent = ${percent}::numeric, version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and version = ${expectedVersion}
      returning id::text as id`;
    if (rows.length === 0) throw conflict('نسخه سهامدار تغییر کرده است.');
  }

  async insertShareholderTransaction(
    tx: SqlSession,
    input: {
      readonly shareholderId: bigint;
      readonly transactionType: string;
      readonly direction: 'in' | 'out';
      readonly amount: bigint;
      readonly transactionDate: string;
      readonly description?: string;
      readonly journalEntryId?: bigint;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.shareholder_transactions
        (shareholder_id, transaction_type, direction, amount, transaction_date, description, journal_entry_id)
      values
        (${input.shareholderId.toString()}, ${input.transactionType}, ${input.direction},
         ${input.amount.toString()}, ${input.transactionDate}, ${input.description ?? null},
         ${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت تراکنش سهامدار انجام نشد.');
    return BigInt(id);
  }
}
