/** Reporting repository: definitions, runs, widgets, exports and KPI read models. */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';
import type { SqlSession } from '../accounting/persistence/sql-support';
import { conflict, notFound } from '../accounting/persistence/sql-support';

export interface ReportDefinitionRecord {
  readonly id: bigint;
  readonly code: string;
  readonly nameFa: string;
  readonly module: string;
  readonly reportKind: string;
  readonly requiredPermissions: readonly string[];
  readonly parameterSchema: string;
  readonly isSystem: boolean;
  readonly isActive: boolean;
}

export interface ReportRunRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly reportId: bigint;
  readonly reportCode: string;
  readonly requestedBy: bigint;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly rowCount: number | null;
  readonly outputFileId: bigint | null;
  readonly errorMessage: string | null;
  readonly durationMs: number | null;
  readonly createdAt: string;
}

export interface WidgetRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly code: string;
  readonly nameFa: string;
  readonly widgetType: string;
  readonly module: string;
  readonly config: string;
  readonly requiredPermissionKey: string | null;
  readonly cacheSeconds: number;
  readonly isActive: boolean;
}

export interface ExportRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly entity: string;
  readonly format: string;
  readonly status: string;
  readonly rowCount: number | null;
  readonly fileId: bigint | null;
  readonly createdAt: string;
  readonly createdBy: bigint | null;
}

@Injectable()
export class ReportingRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listDefinitions(
    orgId: bigint,
    filter: { readonly category?: string; readonly module?: string } = {},
  ): Promise<readonly ReportDefinitionRecord[]> {
    const rows = await this.db<{
      id: string; code: string; name_fa: string; module: string; report_kind: string;
      required_permissions: string[] | null; parameter_schema: unknown; is_system: boolean; is_active: boolean;
    }[]>`
      select id::text as id, code, name_fa, module, report_kind,
             coalesce(required_permissions, array[]::text[]) as required_permissions,
             parameter_schema, is_system, is_active
        from erp.report_definitions
       where organization_id = ${orgId.toString()}
         and (${filter.category ?? null}::text is null or module = ${filter.category ?? null})
         and (${filter.module ?? null}::text is null or module = ${filter.module ?? null})
       order by module, code`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      code: row.code,
      nameFa: row.name_fa,
      module: row.module,
      reportKind: row.report_kind,
      requiredPermissions: row.required_permissions ?? [],
      parameterSchema: JSON.stringify(row.parameter_schema ?? {}),
      isSystem: row.is_system,
      isActive: row.is_active,
    }));
  }

  async findDefinition(orgId: bigint, code: string): Promise<ReportDefinitionRecord | undefined> {
    const all = await this.listDefinitions(orgId);
    return all.find((definition) => definition.code === code);
  }

  async insertDefinition(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly nameFa: string;
      readonly module: string;
      readonly reportKind: string;
      readonly requiredPermissions: readonly string[];
      readonly parameterSchema: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.report_definitions
        (organization_id, code, name_fa, module, report_kind, query_definition,
         parameter_schema, required_permissions, is_system, is_active, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.nameFa}, ${input.module},
         ${input.reportKind}, '{}'::jsonb, ${input.parameterSchema}::jsonb,
         ${[...input.requiredPermissions]}, false, true,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد تعریف گزارش انجام نشد.');
    return BigInt(id);
  }

  async insertRun(
    tx: SqlSession,
    input: {
      readonly reportId: bigint;
      readonly requestedBy: bigint;
      readonly parameters: string;
      readonly status: string;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.report_runs (report_id, requested_by, parameters, status, started_at)
      values (${input.reportId.toString()}, ${input.requestedBy.toString()},
              ${input.parameters}::jsonb, ${input.status},
              case when ${input.status} in ('running','succeeded') then now() else null end)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد اجرای گزارش انجام نشد.');
    return BigInt(id);
  }

  async completeRun(
    tx: SqlSession,
    input: {
      readonly id: bigint;
      readonly status: string;
      readonly rowCount?: number;
      readonly outputFileId?: bigint;
      readonly errorMessage?: string;
      readonly durationMs?: number;
    },
  ): Promise<void> {
    await tx`
      update erp.report_runs
         set status = ${input.status}, finished_at = now(),
             row_count = ${input.rowCount ?? null},
             output_file_id = ${input.outputFileId === undefined ? null : input.outputFileId.toString()}::bigint,
             error_message = ${input.errorMessage ?? null},
             duration_ms = ${input.durationMs ?? null}
       where id = ${input.id.toString()}`;
  }

  async listRuns(
    orgId: bigint,
    filter: { readonly reportCode?: string; readonly status?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly ReportRunRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; report_id: string; report_code: string; requested_by: string;
      status: string; started_at: string | null; finished_at: string | null; row_count: number | null;
      output_file_id: string | null; error_message: string | null; duration_ms: number | null; created_at: string;
    }[]>`
      select r.id::text as id, r.public_id::text as public_id, r.report_id::text as report_id,
             d.code as report_code, r.requested_by::text as requested_by, r.status,
             r.started_at::text as started_at, r.finished_at::text as finished_at, r.row_count,
             r.output_file_id::text as output_file_id, r.error_message, r.duration_ms,
             r.created_at::text as created_at
        from erp.report_runs r
        join erp.report_definitions d on d.id = r.report_id
       where d.organization_id = ${orgId.toString()}
         and (${filter.reportCode ?? null}::text is null or d.code = ${filter.reportCode ?? null})
         and (${filter.status ?? null}::text is null or r.status = ${filter.status ?? null})
       order by r.created_at desc
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      reportId: BigInt(row.report_id),
      reportCode: row.report_code,
      requestedBy: BigInt(row.requested_by),
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      rowCount: row.row_count,
      outputFileId: row.output_file_id === null ? null : BigInt(row.output_file_id),
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  }

  async findRun(orgId: bigint, id: bigint): Promise<ReportRunRecord | undefined> {
    const rows = await this.db<{
      id: string; public_id: string; report_id: string; report_code: string; requested_by: string;
      status: string; started_at: string | null; finished_at: string | null; row_count: number | null;
      output_file_id: string | null; error_message: string | null; duration_ms: number | null; created_at: string;
    }[]>`
      select r.id::text as id, r.public_id::text as public_id, r.report_id::text as report_id,
             d.code as report_code, r.requested_by::text as requested_by, r.status,
             r.started_at::text as started_at, r.finished_at::text as finished_at, r.row_count,
             r.output_file_id::text as output_file_id, r.error_message, r.duration_ms,
             r.created_at::text as created_at
        from erp.report_runs r
        join erp.report_definitions d on d.id = r.report_id
       where d.organization_id = ${orgId.toString()} and r.id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: BigInt(row.id),
      publicId: row.public_id,
      reportId: BigInt(row.report_id),
      reportCode: row.report_code,
      requestedBy: BigInt(row.requested_by),
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      rowCount: row.row_count,
      outputFileId: row.output_file_id === null ? null : BigInt(row.output_file_id),
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    };
  }

  async widgets(orgId: bigint, filter: { readonly module?: string; readonly active?: boolean } = {}): Promise<readonly WidgetRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; code: string; name_fa: string; widget_type: string;
      module: string; config: unknown; required_permission_key: string | null; cache_seconds: number; is_active: boolean;
    }[]>`
      select id::text as id, public_id::text as public_id, code, name_fa, widget_type, module,
             config, required_permissions[1] as required_permission_key, cache_seconds, is_active
        from erp.dashboard_widgets
       where organization_id = ${orgId.toString()}
         and (${filter.module ?? null}::text is null or module = ${filter.module ?? null})
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
       order by code`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      nameFa: row.name_fa,
      widgetType: row.widget_type,
      module: row.module,
      config: JSON.stringify(row.config ?? {}),
      requiredPermissionKey: row.required_permission_key,
      cacheSeconds: row.cache_seconds,
      isActive: row.is_active,
    }));
  }

  /* ------------------------------- exports -------------------------------- */

  async insertExport(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly entity: string;
      readonly format: string;
      readonly filters: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.export_jobs
        (organization_id, entity_type, format, filter_json, status, created_by)
      values
        (${input.orgId.toString()}, ${input.entity}, ${input.format},
         ${input.filters}::jsonb, 'queued',
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد خروجی انجام نشد.');
    return BigInt(id);
  }

  async completeExport(tx: SqlSession, id: bigint, fileId: bigint | null, rowCount: number): Promise<void> {
    await tx`
      update erp.export_jobs
         set status = 'completed', output_file_id = ${fileId === null ? null : fileId.toString()}::bigint,
             row_count = ${rowCount}, finished_at = now()
       where id = ${id.toString()}`;
  }

  async listExports(
    orgId: bigint,
    filter: { readonly entity?: string; readonly status?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly ExportRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; entity: string; format: string; status: string;
      row_count: number | null; file_id: string | null; created_at: string; created_by: string | null;
    }[]>`
      select id::text as id, public_id::text as public_id, entity, format, status, row_count,
             file_id::text as file_id, created_at::text as created_at, created_by::text as created_by
        from erp.export_jobs
       where organization_id = ${orgId.toString()}
         and (${filter.entity ?? null}::text is null or entity = ${filter.entity ?? null})
         and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
       order by created_at desc
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      entity: row.entity,
      format: row.format,
      status: row.status,
      rowCount: row.row_count,
      fileId: row.file_id === null ? null : BigInt(row.file_id),
      createdAt: row.created_at,
      createdBy: row.created_by === null ? null : BigInt(row.created_by),
    }));
  }

  async findExport(orgId: bigint, id: bigint): Promise<ExportRecord | undefined> {
    const rows = await this.listExports(orgId, {});
    return rows.find((row) => row.id === id);
  }

  async deleteExport(tx: SqlSession, orgId: bigint, id: bigint): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.export_jobs where organization_id = ${orgId.toString()} and id = ${id.toString()}
      returning id::text as id`;
    if (rows.length === 0) throw notFound('خروجی');
  }
}
