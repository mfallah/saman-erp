import { asDb } from '../persistence/sql-support';
/** Chart-of-accounts application service (CoA CRUD/tree + analytics materialisation). */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { buildCoaManifest, costCenterAccountCode, COA_L5_TEMPLATES, projectAccountCode } from './coa-manifest';
import type { ChartOfAccountsRepository } from './chart-of-accounts.repository';
import type { AccountFilter, AccountRecord } from './chart-of-accounts.repository';

export interface CreateAccountInput {
  readonly code: string;
  readonly nameFa: string;
  readonly nameEn?: string;
  readonly parentId?: bigint;
  readonly type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  readonly level: number;
  readonly isPostable: boolean;
  readonly currency?: string;
  readonly normalBalance?: 'debit' | 'credit';
}

export interface AccountTreeNode extends AccountRecord {
  readonly children: readonly AccountTreeNode[];
}

@Injectable()
export class ChartOfAccountsService {
  constructor(
    private readonly repo: ChartOfAccountsRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  list(ctx: TenantContext, filter: AccountFilter): Promise<readonly AccountRecord[]> {
    return this.repo.list(ctx.orgId, filter);
  }

  async get(ctx: TenantContext, id: bigint): Promise<AccountRecord> {
    const account = await this.repo.findById(ctx.orgId, id);
    if (account === undefined) {
      throw new AppError('NOT_FOUND', { message: 'حساب یافت نشد.' });
    }
    return account;
  }

  async tree(ctx: TenantContext, options: { readonly depth?: number; readonly activeOnly?: boolean } = {}): Promise<readonly AccountTreeNode[]> {
    const accounts = await this.repo.list(ctx.orgId, {
      ...(options.activeOnly === true ? { active: true } : {}),
      page: { limit: 200, offset: 0 },
    });
    const depth = options.depth ?? 6;
    const byId = new Map(accounts.map((account) => [account.id.toString(), account]));
    const childrenOf = new Map<string, AccountRecord[]>();
    for (const account of accounts) {
      const key = account.parentId === null ? 'root' : account.parentId.toString();
      const bucket = childrenOf.get(key) ?? [];
      bucket.push(account);
      childrenOf.set(key, bucket);
    }
    const build = (parentKey: string, level: number): AccountTreeNode[] => {
      if (level > depth) return [];
      const rows = childrenOf.get(parentKey) ?? [];
      return rows.map((row) => ({ ...row, children: build(row.id.toString(), level + 1) }));
    };
    // keep the map referenced for parents that are filtered out by the page size
    void byId;
    return build('root', 1);
  }

  async create(ctx: TenantContext, input: CreateAccountInput): Promise<AccountRecord> {
    await this.repo.assertCodeFree(ctx.orgId, input.code);
    const depth = input.code.split('-').length;
    if (depth !== input.level) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'code', rule: 'code_depth_must_match_level', params: { depth, level: input.level } }],
        message: 'عمق کد حساب با سطح انتخاب‌شده برابر نیست.',
      });
    }
    let parentId: bigint | null = null;
    let accountType = input.type;
    let normalBalance: 'debit' | 'credit' = input.normalBalance ?? (input.type === 'asset' || input.type === 'expense' ? 'debit' : 'credit');
    if (input.parentId !== undefined) {
      const parent = await this.get(ctx, input.parentId);
      if (parent.accountLevel !== input.level - 1) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'parentId', rule: 'parent_level' }],
          message: 'حساب والد باید دقیقاً یک سطح بالاتر باشد.',
        });
      }
      parentId = parent.id;
      accountType = parent.accountType as CreateAccountInput['type'];
      normalBalance = parent.normalBalance as 'debit' | 'credit';
    } else if (input.level > 1) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'parentId', rule: 'required_above_level_1' }],
        message: 'برای سطوح پایین‌تر از گروه، حساب والد الزامی است.',
      });
    }
    if (input.isPostable && input.level < 4) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'isPostable', rule: 'postable_min_level_4' }],
        message: 'تنها حساب‌های سطح ۴ و پایین‌تر قابل ثبت هستند.',
      });
    }

    return this.db.begin(async (tx) => {
      const account = await this.repo.insert(tx, {
        orgId: ctx.orgId,
        code: input.code,
        nameFa: input.nameFa,
        ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
        accountLevel: input.level,
        parentId,
        accountType,
        normalBalance,
        nature: 'operational',
        isPostable: input.isPostable,
        currency: input.currency ?? 'IRR',
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'accounting.coa.create',
        entityType: 'chart_of_account',
        entityId: account.id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: account.code, nameFa: account.nameFa, level: account.accountLevel },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.coa.created',
        aggregateType: 'chart_of_account',
        aggregateId: account.id,
        payload: { code: account.code, accountLevel: account.accountLevel },
      });
      return account;
    });
  }

  async update(
    ctx: TenantContext,
    id: bigint,
    input: { readonly nameFa?: string; readonly nameEn?: string; readonly isActive?: boolean },
    expectedVersion: number,
  ): Promise<AccountRecord> {
    const current = await this.get(ctx, id);
    if (input.isActive === false && current.isPostable) {
      const used = await this.repo.countJournalLines(ctx.orgId, id);
      if (used > 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'account_in_use', params: { entries: used } }],
          message: 'حساب دارای گردش است و غیرفعال نمی‌شود.',
        });
      }
    }
    return this.db.begin(async (tx) => {
      const account = await this.repo.update(tx, ctx.orgId, id, input, expectedVersion);
      await this.audit.record(asDb(tx), {
        action: 'accounting.coa.update',
        entityType: 'chart_of_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { nameFa: current.nameFa, isActive: current.isActive },
        after: { nameFa: account.nameFa, isActive: account.isActive },
      });
      return account;
    });
  }

  async delete(ctx: TenantContext, id: bigint): Promise<void> {
    const account = await this.get(ctx, id);
    const children = await this.repo.countChildren(ctx.orgId, id);
    if (children > 0) {
      throw new AppError('RULE_VIOLATION', {
        details: [{ rule: 'account_has_children', params: { children } }],
        message: 'حساب دارای زیرمجموعه است و قابل حذف نیست.',
      });
    }
    const entries = await this.repo.countJournalLines(ctx.orgId, id);
    if (entries > 0) {
      throw new AppError('RULE_VIOLATION', {
        details: [{ rule: 'account_has_entries', params: { entries } }],
        message: 'حساب دارای سند است و قابل حذف نیست.',
      });
    }
    await this.db.begin(async (tx) => {
      await this.repo.softDelete(tx, ctx.orgId, id);
      await this.audit.record(asDb(tx), {
        action: 'accounting.coa.delete',
        entityType: 'chart_of_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { code: account.code },
      });
    });
  }

  /** Idempotent standard-CoA import (`POST /accounting/accounts/import`). */
  async importManifest(ctx: TenantContext): Promise<{ readonly created: number }> {
    return this.db.begin(async (tx) => {
      const created = await this.repo.seedManifest(tx, ctx.orgId, ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.coa.import',
        entityType: 'chart_of_account',
        entityId: 0n,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { created, manifestRows: buildCoaManifest().length },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.coa.imported',
        aggregateType: 'chart_of_account',
        aggregateId: 0n,
        payload: { created },
      });
      return { created };
    });
  }

  /**
   * Lazily materialises an L5 cost-center account (`<L4>-<cc>`) the first time a
   * journal line carries that cost center (`DATA-MODEL §6.3`).
   */
  async ensureCostCenterAccount(ctx: TenantContext, accountId: bigint, costCenterCode: string): Promise<AccountRecord> {
    const parent = await this.get(ctx, accountId);
    if (parent.accountLevel !== 4) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'accountId', rule: 'cost_center_extends_l4' }],
        message: 'مرکز هزینه تنها روی حساب تفصیلی (سطح ۴) تعریف می‌شود.',
      });
    }
    const code = costCenterAccountCode(parent.code, costCenterCode);
    const existing = await this.repo.findByCode(ctx.orgId, code);
    if (existing !== undefined) return existing;
    const template = COA_L5_TEMPLATES.find((row) => row.code === costCenterCode);
    if (template === undefined) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'costCenterCode', rule: 'unknown_template' }],
        message: 'کد مرکز هزینه شناخته‌شده نیست.',
      });
    }
    return this.create(ctx, {
      code,
      nameFa: `${parent.nameFa} - ${template.nameFa}`,
      parentId: parent.id,
      type: parent.accountType as CreateAccountInput['type'],
      level: 5,
      isPostable: true,
    });
  }

  /** Lazily materialises an L6 project account; parent is the **L5** row. */
  async ensureProjectAccount(ctx: TenantContext, costCenterAccountId: bigint, projectCode: string): Promise<AccountRecord> {
    const parent = await this.get(ctx, costCenterAccountId);
    if (parent.accountLevel !== 5) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'costCenterAccountId', rule: 'project_extends_l5' }],
        message: 'حساب پروژه تنها روی حساب مرکز هزینه (سطح ۵) تعریف می‌شود.',
      });
    }
    const code = projectAccountCode(parent.code, projectCode);
    const existing = await this.repo.findByCode(ctx.orgId, code);
    if (existing !== undefined) return existing;
    return this.create(ctx, {
      code,
      nameFa: `${parent.nameFa} - پروژه ${projectCode}`,
      parentId: parent.id,
      type: parent.accountType as CreateAccountInput['type'],
      level: 6,
      isPostable: true,
    });
  }
}
