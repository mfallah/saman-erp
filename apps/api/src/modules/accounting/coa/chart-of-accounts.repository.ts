import type { SqlSession } from '../persistence/sql-support';
/** Chart-of-accounts repository (tenant-scoped raw SQL; owns `erp.chart_of_accounts`). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { buildCoaManifest, COA_MANIFEST_COUNTS } from '../coa/coa-manifest';
import type { CoaRow } from '../coa/coa-manifest';
import { conflict, notFound, normalisePagination } from '../persistence/sql-support';
import type { Pagination } from '../persistence/sql-support';

export interface AccountRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly organizationId: bigint;
  readonly code: string;
  readonly nameFa: string;
  readonly nameEn: string | null;
  readonly accountLevel: number;
  readonly parentId: bigint | null;
  readonly accountType: string;
  readonly normalBalance: string;
  readonly nature: string;
  readonly isPostable: boolean;
  readonly isActive: boolean;
  readonly currency: string;
  readonly description: string | null;
  readonly version: number;
}

interface AccountRow {
  id: string;
  public_id: string;
  organization_id: string;
  code: string;
  name_fa: string;
  name_en: string | null;
  account_level: number;
  parent_id: string | null;
  account_type: string;
  normal_balance: string;
  nature: string;
  is_postable: boolean;
  is_active: boolean;
  currency: string;
  description: string | null;
  version: number;
}

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    organizationId: BigInt(row.organization_id),
    code: row.code,
    nameFa: row.name_fa,
    nameEn: row.name_en,
    accountLevel: row.account_level,
    parentId: row.parent_id === null ? null : BigInt(row.parent_id),
    accountType: row.account_type,
    normalBalance: row.normal_balance,
    nature: row.nature,
    isPostable: row.is_postable,
    isActive: row.is_active,
    currency: row.currency,
    description: row.description,
    version: row.version,
  };
}

const SELECT_ACCOUNT = `
  select id::text as id, public_id::text as public_id, organization_id::text as organization_id,
         code, name_fa, name_en, account_level, parent_id::text as parent_id,
         account_type, normal_balance, nature, is_postable, is_active, currency,
         description, version
    from erp.chart_of_accounts`;

export interface AccountFilter {
  readonly level?: number;
  readonly parentId?: bigint;
  readonly type?: string;
  readonly active?: boolean;
  readonly codePrefix?: string;
  readonly page?: { readonly limit?: number; readonly offset?: number };
}

@Injectable()
export class ChartOfAccountsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(orgId: bigint, filter: AccountFilter = {}): Promise<readonly AccountRecord[]> {
    const page = normalisePagination(filter.page ?? {});
    const rows = await this.db<AccountRow[]>`
      ${this.db.unsafe(SELECT_ACCOUNT)}
       where organization_id = ${orgId.toString()}
         and deleted_at is null
         and (${filter.level ?? null}::int is null or account_level = ${filter.level ?? null})
         and (${filter.parentId === undefined ? null : filter.parentId.toString()}::bigint is null or parent_id = ${filter.parentId === undefined ? null : filter.parentId.toString()}::bigint)
         and (${filter.type ?? null}::text is null or account_type = ${filter.type ?? null})
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
         and (${filter.codePrefix ?? null}::text is null or code like ${filter.codePrefix ?? ''} || '%')
       order by code
       limit ${page.limit} offset ${page.offset}`;
    return rows.map(toAccount);
  }

  async findById(orgId: bigint, id: bigint): Promise<AccountRecord | undefined> {
    const rows = await this.db<AccountRow[]>`
      ${this.db.unsafe(SELECT_ACCOUNT)}
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and deleted_at is null`;
    const row = rows[0];
    return row === undefined ? undefined : toAccount(row);
  }

  async findByCode(orgId: bigint, code: string): Promise<AccountRecord | undefined> {
    const rows = await this.db<AccountRow[]>`
      ${this.db.unsafe(SELECT_ACCOUNT)}
       where organization_id = ${orgId.toString()} and code = ${code} and deleted_at is null`;
    const row = rows[0];
    return row === undefined ? undefined : toAccount(row);
  }

  /** Resolves many codes in one round trip (posting engine hot path). */
  async findByCodes(
    tx: SqlSession,
    orgId: bigint,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, AccountRecord>> {
    if (codes.length === 0) return new Map();
    const rows = await tx<AccountRow[]>`
      ${tx.unsafe(SELECT_ACCOUNT)}
       where organization_id = ${orgId.toString()}
         and code = any(${codes})
         and deleted_at is null`;
    return new Map(rows.map((row) => {
      const account = toAccount(row);
      return [account.code, account];
    }));
  }

  /** Resolves account ids in one round trip (journal validation hot path). */
  async findByIds(tx: SqlSession, orgId: bigint, ids: readonly bigint[]): Promise<readonly AccountRecord[]> {
    if (ids.length === 0) return [];
    const rows = await tx<AccountRow[]>`
      ${tx.unsafe(SELECT_ACCOUNT)}
       where organization_id = ${orgId.toString()}
         and id = any(${ids.map((id) => id.toString())}::bigint[])
         and deleted_at is null`;
    return rows.map(toAccount);
  }

  /** Resolve the API-facing public id (or numeric code-free id) to the internal key. */
  async idByPublicId(orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await this.db<{ id: string }[]>`
      select id::text as id from erp.chart_of_accounts
       where organization_id = ${orgId.toString()} and public_id = ${publicId}::uuid and deleted_at is null
       limit 1`;
    const row = rows[0];
    return row === undefined ? null : BigInt(row.id);
  }

  async assertCodeFree(orgId: bigint, code: string): Promise<void> {
    const existing = await this.findByCode(orgId, code);
    if (existing !== undefined) throw conflict('کد حساب تکراری است.');
  }

  async insert(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly nameFa: string;
      readonly nameEn?: string;
      readonly accountLevel: number;
      readonly parentId: bigint | null;
      readonly accountType: string;
      readonly normalBalance: string;
      readonly nature: string;
      readonly isPostable: boolean;
      readonly currency: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<AccountRecord> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.chart_of_accounts
        (organization_id, code, name_fa, name_en, account_level, parent_id, account_type,
         normal_balance, nature, is_postable, is_active, currency, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.nameFa}, ${input.nameEn ?? null},
         ${input.accountLevel}, ${input.parentId === null ? null : input.parentId.toString()},
         ${input.accountType}, ${input.normalBalance}, ${input.nature}, ${input.isPostable},
         true, ${input.currency}, ${input.createdBy === null ? null : input.createdBy.toString()})
      returning id::text as id`;
    const row = rows[0];
    if (row === undefined) throw conflict('ایجاد حساب انجام نشد.');
    const account = await this.findById(input.orgId, BigInt(row.id));
    if (account === undefined) throw notFound('حساب');
    return account;
  }

  async update(
    tx: SqlSession,
    orgId: bigint,
    id: bigint,
    input: { readonly nameFa?: string; readonly nameEn?: string; readonly isActive?: boolean },
    expectedVersion: number,
  ): Promise<AccountRecord> {
    const rows = await tx<{ id: string }[]>`
      update erp.chart_of_accounts
         set name_fa = coalesce(${input.nameFa ?? null}, name_fa),
             name_en = coalesce(${input.nameEn ?? null}, name_en),
             is_active = coalesce(${input.isActive ?? null}, is_active),
             version = version + 1,
             updated_at = now()
       where organization_id = ${orgId.toString()} and id = ${id.toString()}
         and version = ${expectedVersion} and deleted_at is null
      returning id::text as id`;
    if (rows.length === 0) {
      const existing = await this.findById(orgId, id);
      if (existing === undefined) throw notFound('حساب');
      throw conflict('نسخه حساب تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.');
    }
    const account = await this.findById(orgId, id);
    if (account === undefined) throw notFound('حساب');
    return account;
  }

  async softDelete(tx: SqlSession, orgId: bigint, id: bigint): Promise<void> {
    await tx`
      update erp.chart_of_accounts
         set deleted_at = now(), is_active = false, version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and deleted_at is null`;
  }

  async countChildren(orgId: bigint, id: bigint): Promise<number> {
    const rows = await this.db<{ count: string }[]>`
      select count(*)::text as count from erp.chart_of_accounts
       where organization_id = ${orgId.toString()} and parent_id = ${id.toString()} and deleted_at is null`;
    return Number(rows[0]?.count ?? '0');
  }

  async countJournalLines(orgId: bigint, accountId: bigint): Promise<number> {
    const rows = await this.db<{ count: string }[]>`
      select count(*)::text as count
        from erp.journal_lines l
        join erp.journal_entries e on e.id = l.journal_entry_id
       where e.organization_id = ${orgId.toString()} and l.account_id = ${accountId.toString()}`;
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Idempotent standard-CoA import: inserts any missing manifest row in parent
   * order and returns how many rows were created.
   */
  async seedManifest(tx: SqlSession, orgId: bigint, createdBy: bigint | null): Promise<number> {
    const manifest: readonly CoaRow[] = buildCoaManifest();
    let created = 0;
    for (const row of manifest) {
      const existing = await tx<{ id: string }[]>`
        select id::text as id from erp.chart_of_accounts
         where organization_id = ${orgId.toString()} and code = ${row.code} and deleted_at is null`;
      if (existing.length > 0) continue;
      const parent = row.parentCode === null
        ? undefined
        : await tx<{ id: string }[]>`
            select id::text as id from erp.chart_of_accounts
             where organization_id = ${orgId.toString()} and code = ${row.parentCode} and deleted_at is null`;
      const parentId = parent?.[0]?.id;
      await tx`
        insert into erp.chart_of_accounts
          (organization_id, code, name_fa, account_level, parent_id, account_type, normal_balance,
           nature, is_postable, is_active, currency, created_by)
        values
          (${orgId.toString()}, ${row.code}, ${row.nameFa}, ${row.accountLevel},
           ${parentId ?? null}, ${row.accountType}, ${row.normalBalance}, ${row.nature},
           ${row.isPostable}, true, ${row.currency}, ${createdBy === null ? null : createdBy.toString()})`;
      created += 1;
    }
    return created;
  }

  /** Asserts the persisted tree still matches the manifest counts. */
  async assertManifestCounts(orgId: bigint): Promise<Record<string, number>> {
    const rows = await this.db<{ account_level: number; count: string }[]>`
      select account_level, count(*)::text as count
        from erp.chart_of_accounts
       where organization_id = ${orgId.toString()} and deleted_at is null
       group by account_level`;
    const byLevel = new Map(rows.map((row) => [row.account_level, Number(row.count)]));
    const actual = {
      l1: byLevel.get(1) ?? 0,
      l2: byLevel.get(2) ?? 0,
      l3: byLevel.get(3) ?? 0,
      l4: byLevel.get(4) ?? 0,
    };
    if (actual.l1 !== COA_MANIFEST_COUNTS.l1 || actual.l2 !== COA_MANIFEST_COUNTS.l2) {
      throw conflict('ساختار حساب‌های استاندارد کامل نیست.');
    }
    return actual;
  }
}
