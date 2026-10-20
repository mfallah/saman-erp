/**
 * Reporting service: registry with permission enforcement at run **and** export,
 * report runs, dashboards (strictest widget permission) and async exports.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../common/contracts';
import { asDb, notFound, validation } from '../treasury/persistence/sql-support';
import { ReportingRepository } from './reporting.repository';
import type { ExportRecord, ReportDefinitionRecord, ReportRunRecord, WidgetRecord } from './reporting.repository';
import { ReportingReadModel } from './read-model.repository';
import { assertReportPermissions, dashboardRequiredPermissions, entityExportPermissions, hasAllPermissions, isExportExpired, shouldRunAsync } from './report-registry';

export interface RunReportInput {
  readonly params: { readonly from: string; readonly to: string; readonly filters?: Readonly<Record<string, unknown>> };
  readonly async?: boolean;
  readonly format?: 'json' | 'csv' | 'xlsx' | 'pdf';
}

export interface RunReportResult {
  readonly runId: bigint;
  readonly async: boolean;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly repo: ReportingRepository,
    private readonly readModel: ReportingReadModel,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  /** Catalog only lists reports the actor may run (no metadata leakage). */
  async catalog(ctx: TenantContext, filter: { readonly category?: string } = {}): Promise<readonly ReportDefinitionRecord[]> {
    const definitions = await this.repo.listDefinitions(ctx.orgId, filter);
    return definitions.filter((definition) => hasAllPermissions(ctx, definition.requiredPermissions));
  }

  async getDefinition(ctx: TenantContext, code: string): Promise<ReportDefinitionRecord> {
    const definition = await this.requireDefinition(ctx, code);
    return definition;
  }

  /** Runs a report synchronously when small, otherwise queues an async run. */
  async run(ctx: TenantContext, code: string, input: RunReportInput): Promise<RunReportResult> {
    const definition = await this.requireDefinition(ctx, code);
    assertReportPermissions(ctx, definition.requiredPermissions, 'run');
    if (!this.readModel.supports(code)) {
      throw new AppError('NOT_IMPLEMENTED', {
        details: [{ rule: 'report_read_model_missing', params: { code } }],
        message: 'مدل خواندنی این گزارش هنوز پیاده‌سازی نشده است.',
      });
    }
    const isAsync = shouldRunAsync(input.async === true, undefined);
    return this.db.begin(async (tx) => {
      const runId = await this.repo.insertRun(tx, {
        reportId: definition.id,
        requestedBy: ctx.actorId ?? 0n,
        parameters: JSON.stringify(input.params),
        status: isAsync ? 'queued' : 'running',
      });
      if (isAsync) {
        await this.repo.completeRun(tx, { id: runId, status: 'queued' });
        await this.audit.record(asDb(tx), {
          action: 'report.run.async',
          entityType: 'report_run',
          entityId: runId,
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          after: { report: code },
        });
        return { runId, async: true, rows: [], rowCount: 0 };
      }
      const startedAt = Date.now();
      const rows = await this.readModel.run(code, ctx.orgId, {
        from: input.params.from,
        to: input.params.to,
        limit: 5_000,
      });
      await this.repo.completeRun(tx, {
        id: runId,
        status: 'succeeded',
        rowCount: rows.length,
        durationMs: Date.now() - startedAt,
      });
      await this.audit.record(asDb(tx), {
        action: 'report.run',
        entityType: 'report_run',
        entityId: runId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { report: code, rowCount: rows.length },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'reporting.report.completed',
        aggregateType: 'report_run',
        aggregateId: runId,
        payload: { report: code, rowCount: rows.length },
      });
      return { runId, async: false, rows, rowCount: rows.length };
    });
  }

  listRuns(
    ctx: TenantContext,
    filter: { readonly reportCode?: string; readonly status?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly ReportRunRecord[]> {
    return this.repo.listRuns(ctx.orgId, filter);
  }

  async getRun(ctx: TenantContext, id: bigint): Promise<ReportRunRecord> {
    const run = await this.repo.findRun(ctx.orgId, id);
    if (run === undefined) throw notFound('اجرای گزارش');
    return run;
  }

  /**
   * Download/export gate: the report's own permissions are re-checked (a run id is
   * not a capability) and only completed runs with an artifact are returned.
   */
  async downloadRun(ctx: TenantContext, id: bigint): Promise<{ fileId: bigint | null; rowCount: number }> {
    const run = await this.getRun(ctx, id);
    const definition = await this.requireDefinition(ctx, run.reportCode);
    assertReportPermissions(ctx, definition.requiredPermissions, 'export');
    if (run.status !== 'succeeded') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این اجرای گزارش خروجی قابل دانلود ندارد.' });
    }
    await this.db.begin(async (tx) => {
      await this.audit.record(asDb(tx), {
        action: 'report.download',
        entityType: 'report_run',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
    });
    return { fileId: run.outputFileId, rowCount: run.rowCount ?? 0 };
  }

  /* ------------------------------- dashboards ------------------------------- */

  /** Visible widgets require their own permission; the dashboard needs all of them. */
  async widgets(ctx: TenantContext): Promise<readonly WidgetRecord[]> {
    const widgets = await this.repo.widgets(ctx.orgId, { active: true });
    return widgets.filter(
      (widget) =>
        widget.requiredPermissionKey === null || hasAllPermissions(ctx, [widget.requiredPermissionKey]),
    );
  }

  async dashboardAccess(ctx: TenantContext): Promise<{ readonly requiredPermissions: readonly string[] }> {
    const widgets = await this.repo.widgets(ctx.orgId, { active: true });
    const required = dashboardRequiredPermissions(
      widgets.map((widget) => ({ requiredPermissionKey: widget.requiredPermissionKey })),
    );
    assertReportPermissions(ctx, required, 'read');
    return { requiredPermissions: required };
  }

  async summary(ctx: TenantContext, date: string): Promise<Record<string, string>> {
    return this.db.begin(async (tx) => {
      const result = await this.readModel.dashboardSummary(ctx.orgId, date);
      await this.audit.record(asDb(tx), {
        action: 'dashboard.summary',
        entityType: 'dashboard',
        entityId: 0n,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { date },
      });
      return result;
    });
  }

  /* --------------------------------- exports -------------------------------- */

  async createExport(
    ctx: TenantContext,
    input: { readonly entity: string; readonly format: 'csv' | 'xlsx'; readonly filters?: Readonly<Record<string, unknown>> },
  ): Promise<{ exportId: bigint }> {
    const required = entityExportPermissions(input.entity);
    assertReportPermissions(ctx, required, 'export');
    return this.db.begin(async (tx) => {
      const exportId = await this.repo.insertExport(tx, {
        orgId: ctx.orgId,
        entity: input.entity,
        format: input.format,
        filters: JSON.stringify(input.filters ?? {}),
        createdBy: ctx.actorId,
      });
      // The worker builds the file; this endpoint only enqueues (never runs SQL in a write tx).
      await this.repo.completeExport(tx, exportId, null, 0);
      await this.audit.record(asDb(tx), {
        action: 'export.create',
        entityType: 'export_job',
        entityId: exportId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { entity: input.entity, format: input.format },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'reporting.export.queued',
        aggregateType: 'export_job',
        aggregateId: exportId,
        payload: { entity: input.entity, format: input.format },
      });
      return { exportId };
    });
  }

  listExports(
    ctx: TenantContext,
    filter: { readonly entity?: string; readonly status?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly ExportRecord[]> {
    return this.repo.listExports(ctx.orgId, filter);
  }

  async getExport(ctx: TenantContext, id: bigint): Promise<ExportRecord> {
    const record = await this.repo.findExport(ctx.orgId, id);
    if (record === undefined) throw notFound('خروجی');
    assertReportPermissions(ctx, entityExportPermissions(record.entity), 'export');
    return record;
  }

  /** Download gate: entity permission + 7-day expiry. */
  async downloadExport(ctx: TenantContext, id: bigint): Promise<{ fileId: bigint | null; expiresIn: number }> {
    const record = await this.getExport(ctx, id);
    if (isExportExpired(record.createdAt)) {
      throw new AppError('RULE_VIOLATION', {
        details: [{ rule: 'export_expired' }],
        message: 'مهلت دانلود این خروجی به پایان رسیده است.',
      });
    }
    if (record.status !== 'completed') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'خروجی هنوز آماده نیست.' });
    }
    return { fileId: record.fileId, expiresIn: 900 };
  }

  async deleteExport(ctx: TenantContext, id: bigint): Promise<void> {
    const record = await this.getExport(ctx, id);
    await this.db.begin(async (tx) => {
      await this.repo.deleteExport(tx, ctx.orgId, id);
      await this.audit.record(asDb(tx), {
        action: 'export.delete',
        entityType: 'export_job',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { entity: record.entity },
      });
    });
  }

  /** Custom definition creation requires `report.create` (guard) + unique code. */
  async createDefinition(
    ctx: TenantContext,
    input: {
      readonly code: string;
      readonly titleFa: string;
      readonly category: string;
      readonly queryTemplateId: string;
      readonly requiredPermissions?: readonly string[];
    },
  ): Promise<bigint> {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(input.code)) {
      throw validation('کد گزارش باید با حروف کوچک و خط تیره باشد.', 'code', 'slug');
    }
    const existing = await this.repo.findDefinition(ctx.orgId, input.code);
    if (existing !== undefined) {
      throw new AppError('CONFLICT', { message: 'کد گزارش تکراری است.' });
    }
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertDefinition(tx, {
        orgId: ctx.orgId,
        code: input.code,
        nameFa: input.titleFa,
        module: input.category,
        reportKind: 'sql',
        requiredPermissions: input.requiredPermissions ?? ['report.read'],
        parameterSchema: JSON.stringify({ type: 'object' }),
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'report.create',
        entityType: 'report_definition',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, titleFa: input.titleFa },
      });
      return id;
    });
  }

  private async requireDefinition(ctx: TenantContext, code: string): Promise<ReportDefinitionRecord> {
    const definition = await this.repo.findDefinition(ctx.orgId, code);
    if (definition === undefined || !definition.isActive) {
      throw new AppError('NOT_FOUND', {
        details: [{ field: 'code', rule: 'unknown_report', params: { code } }],
        message: 'گزارش درخواستی یافت نشد.',
      });
    }
    return definition;
  }
}
