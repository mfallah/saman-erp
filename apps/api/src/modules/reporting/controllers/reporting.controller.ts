/** Reporting HTTP surface (`API.md §4.14`). */
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { ReportingService } from '../reporting.service';
import { parseDto, toBigInt, RunReportSchema, CreateDefinitionSchema, CreateExportSchema } from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';

@ApiTags('reporting')
@Controller()
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('reports')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'فهرست گزارش‌های مجاز' })
  async catalog(
    @Tenant() ctx: TenantContext,
    @Query('category') category?: string,
  ): Promise<{ data: readonly unknown[] }> {
    const definitions = await this.reporting.catalog(ctx, {
      ...(category === undefined ? {} : { category }),
    });
    return {
      data: definitions.map((definition) => ({
        code: definition.code,
        titleFa: definition.nameFa,
        category: definition.module,
        requiredPermissions: definition.requiredPermissions,
        paramsSchema: definition.parameterSchema,
      })),
    };
  }

  @Post('reports')
  @RequirePermissions('report.create')
  @ApiOperation({ summary: 'ایجاد تعریف گزارش سفارشی' })
  async createDefinition(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: { id: string } }> {
    const dto = parseDto(CreateDefinitionSchema, body);
    const id = await this.reporting.createDefinition(ctx, {
      code: dto.code,
      titleFa: dto.titleFa,
      category: dto.category,
      queryTemplateId: dto.queryTemplateId,
      ...(dto.requiredPermissions === undefined ? {} : { requiredPermissions: dto.requiredPermissions }),
    });
    return { data: { id: id.toString() } };
  }

  @Get('reports/:code')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'جزئیات تعریف گزارش' })
  async getDefinition(@Tenant() ctx: TenantContext, @Param('code') code: string): Promise<{ data: unknown }> {
    return { data: await this.reporting.getDefinition(ctx, code) };
  }

  @Post('reports/:code/run')
  @RequirePermissions('report.run')
  @ApiOperation({ summary: 'اجرای گزارش (همگام/ناهمگام) با کنترل دسترسی گزارش' })
  async run(
    @Tenant() ctx: TenantContext,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(RunReportSchema, body);
    return {
      data: await this.reporting.run(ctx, code, {
        params: {
          from: dto.params.from,
          to: dto.params.to,
          ...(dto.params.filters === undefined ? {} : { filters: dto.params.filters }),
        },
        ...(dto.async === undefined ? {} : { async: dto.async }),
        ...(dto.format === undefined ? {} : { format: dto.format }),
      }),
    };
  }

  @Get('reports/runs')
  @RequirePermissions('report.run')
  @ApiOperation({ summary: 'تاریخچه اجرای گزارش‌ها' })
  async listRuns(
    @Tenant() ctx: TenantContext,
    @Query('reportCode') reportCode?: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.reporting.listRuns(ctx, {
        ...(reportCode === undefined ? {} : { reportCode }),
        ...(status === undefined ? {} : { status }),
      }),
    };
  }

  @Get('reports/runs/:id')
  @RequirePermissions('report.run')
  @ApiOperation({ summary: 'وضعیت اجرای گزارش' })
  async getRun(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.reporting.getRun(ctx, toBigInt(id)) };
  }

  @Get('reports/runs/:id/download')
  @RequirePermissions('report.run')
  @ApiOperation({ summary: 'دانلود خروجی گزارش (کنترل دسترسی مجدد)' })
  async downloadRun(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.reporting.downloadRun(ctx, toBigInt(id)) };
  }

  @Get('dashboard/summary')
  @RequirePermissions('dashboard.read')
  @ApiOperation({ summary: 'خلاصه KPI خانه' })
  async summary(
    @Tenant() ctx: TenantContext,
    @Query('date') date?: string,
  ): Promise<{ data: Record<string, string> }> {
    await this.reporting.dashboardAccess(ctx);
    return { data: await this.reporting.summary(ctx, date ?? new Date().toISOString().slice(0, 10)) };
  }

  @Get('dashboards')
  @RequirePermissions('dashboard.read')
  @ApiOperation({ summary: 'ویجت‌های مجاز داشبورد' })
  async widgets(@Tenant() ctx: TenantContext): Promise<{ data: readonly unknown[] }> {
    return { data: await this.reporting.widgets(ctx) };
  }

  @Post('exports')
  @RequirePermissions('export.read')
  @ApiOperation({ summary: 'ایجاد خروجی ناهمگام با کنترل دسترسی موجودیت' })
  async createExport(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: { id: string } }> {
    const dto = parseDto(CreateExportSchema, body);
    const result = await this.reporting.createExport(ctx, {
      entity: dto.entity,
      format: dto.format,
      ...(dto.filters === undefined ? {} : { filters: dto.filters }),
    });
    return { data: { id: result.exportId.toString() } };
  }

  @Get('exports')
  @RequirePermissions('export.read')
  @ApiOperation({ summary: 'تاریخچه خروجی‌ها' })
  async listExports(
    @Tenant() ctx: TenantContext,
    @Query('entity') entity?: string,
    @Query('status') status?: string,
  ): Promise<{ data: readonly unknown[] }> {
    return {
      data: await this.reporting.listExports(ctx, {
        ...(entity === undefined ? {} : { entity }),
        ...(status === undefined ? {} : { status }),
      }),
    };
  }

  @Get('exports/:id/download')
  @RequirePermissions('export.read')
  @ApiOperation({ summary: 'دانلود خروجی با کنترل دسترسی و انقضا' })
  async downloadExport(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: await this.reporting.downloadExport(ctx, toBigInt(id)) };
  }

  @Delete('exports/:id')
  @RequirePermissions('export.delete')
  @ApiOperation({ summary: 'حذف خروجی' })
  async deleteExport(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.reporting.deleteExport(ctx, toBigInt(id));
  }
}
