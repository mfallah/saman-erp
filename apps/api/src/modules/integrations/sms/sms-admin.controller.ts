/**
 * SMS administration (`API.md` §4.15): Limo templates, the outbound message log,
 * 7-day status counters and an operator "send test" that goes through the real
 * Limo service (`SMS_MODE=limo` only) and records the message.
 *
 * Permission keys are the existing ones: `sms.read`, `sms.template.manage`,
 * `sms.send` — no new key is introduced.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppError, normalizeIranianMobile } from '@saman/shared';

import type { TenantContext } from '../../../common/contracts';
import { CurrentTenant } from '../../../common/decorators/current-context.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { apiData } from '../../../common/interceptors/response.interceptor';
import { SmsService } from './sms.service';
import {
  SqlSmsAdminRepository,
  type SmsMessageFilter,
  type TemplateWriteInput,
} from './sms-admin.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,79}$/;
const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'rejected'] as const;
const STATS_WINDOW_DAYS = 7;

type Body_ = Record<string, unknown>;

function bodyOf(body: unknown): Body_ {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_ERROR', { message: 'بدنهٔ درخواست معتبر نیست.' });
  }
  return body as Body_;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(payload: Body_, key: string): string | undefined {
  if (!(key in payload) || payload[key] === undefined || payload[key] === null) return undefined;
  const value = textOf(payload[key]);
  return value.length === 0 ? undefined : value;
}

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError('VALIDATION_ERROR', { message: 'شناسهٔ قالب معتبر نیست.' });
  }
  return value;
}

function normalizeVariables(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'variables باید آرایه‌ای از نام متغیرها باشد.',
    });
  }
  const variables: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new AppError('VALIDATION_ERROR', {
        message: 'هر متغیر باید یک رشته باشد.',
      });
    }
    const trimmed = item.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
    if (trimmed.length === 0 || trimmed.length > 80) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'نام متغیر باید بین ۱ تا ۸۰ نویسه باشد.',
      });
    }
    if (!variables.includes(trimmed)) variables.push(trimmed);
  }
  if (variables.length > 50) {
    throw new AppError('VALIDATION_ERROR', { message: 'تعداد متغیرها بیش از حد مجاز است.' });
  }
  return variables;
}

function optionalBoolean(payload: Body_, key: string): boolean | undefined {
  if (!(key in payload) || payload[key] === undefined || payload[key] === null) return undefined;
  if (typeof payload[key] !== 'boolean') {
    throw new AppError('VALIDATION_ERROR', { message: `${key} باید true یا false باشد.` });
  }
  return payload[key] as boolean;
}

@ApiTags('sms')
@ApiBearerAuth()
@Controller('sms')
export class SmsAdminController {
  constructor(
    private readonly sms: SmsService,
    private readonly repository: SqlSmsAdminRepository,
  ) {}

  @Get('templates')
  @Permissions('sms.read')
  @ApiOperation({ summary: 'قالب‌های پیامک (Limo) با متغیرها و وضعیت فعال' })
  async listTemplates(@CurrentTenant() ctx: TenantContext) {
    const items = await this.repository.listTemplates(ctx.orgId);
    return apiData(items, { pagination: { mode: 'offset', limit: items.length, count: items.length } });
  }

  @Post('templates')
  @Permissions('sms.template.manage')
  @ApiOperation({ summary: 'ایجاد قالب پیامک' })
  async createTemplate(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const payload = bodyOf(body);
    const code = textOf(payload['code']);
    const nameFa = textOf(payload['nameFa']);
    const text = textOf(payload['body']);
    if (!CODE_PATTERN.test(code)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'کد قالب باید ۲ تا ۸۰ نویسهٔ لاتین کوچک (a-z، 0-9، . _ -) باشد.',
      });
    }
    if (nameFa.length < 2 || nameFa.length > 120) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'نام فارسی قالب باید بین ۲ تا ۱۲۰ نویسه باشد.',
      });
    }
    if (text.length === 0 || text.length > 2000) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'متن قالب باید بین ۱ تا ۲۰۰۰ نویسه باشد.',
      });
    }
    const input: TemplateWriteInput = {
      code,
      nameFa,
      body: text,
      variables: normalizeVariables(payload['variables']),
      isActive: optionalBoolean(payload, 'isActive') ?? true,
      purpose: optionalString(payload, 'purpose') ?? 'transactional',
    };
    const created = await this.repository.insertTemplate(ctx.orgId, ctx.actorId, input);
    if (created === null) {
      throw new AppError('CONFLICT', { message: 'کد قالب تکراری است.' });
    }
    return apiData(created);
  }

  @Patch('templates/:id')
  @Permissions('sms.template.manage')
  @ApiOperation({ summary: 'ویرایش قالب پیامک' })
  async updateTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const publicId = requireUuid(id);
    const payload = bodyOf(body);
    const patch: {
      code?: string;
      nameFa?: string;
      body?: string;
      variables?: string[];
      isActive?: boolean;
      purpose?: string;
    } = {};
    const code = optionalString(payload, 'code');
    if (code !== undefined) {
      if (!CODE_PATTERN.test(code)) {
        throw new AppError('VALIDATION_ERROR', { message: 'کد قالب معتبر نیست.' });
      }
      patch.code = code;
    }
    const nameFa = optionalString(payload, 'nameFa');
    if (nameFa !== undefined) {
      if (nameFa.length < 2 || nameFa.length > 120) {
        throw new AppError('VALIDATION_ERROR', { message: 'نام فارسی قالب معتبر نیست.' });
      }
      patch.nameFa = nameFa;
    }
    if ('body' in payload) {
      const text = textOf(payload['body']);
      if (text.length === 0 || text.length > 2000) {
        throw new AppError('VALIDATION_ERROR', { message: 'متن قالب معتبر نیست.' });
      }
      patch.body = text;
    }
    if ('variables' in payload) patch.variables = normalizeVariables(payload['variables']);
    const isActive = optionalBoolean(payload, 'isActive');
    if (isActive !== undefined) patch.isActive = isActive;
    const purpose = optionalString(payload, 'purpose');
    if (purpose !== undefined) patch.purpose = purpose;
    if (Object.keys(patch).length === 0) {
      throw new AppError('VALIDATION_ERROR', { message: 'هیچ فیلدی برای ویرایش ارسال نشده است.' });
    }
    const updated = await this.repository.updateTemplate(ctx.orgId, ctx.actorId, publicId, patch);
    if (updated === null) {
      const existing = await this.repository.findTemplate(ctx.orgId, publicId);
      if (existing === null) throw new AppError('NOT_FOUND', { message: 'قالب یافت نشد.' });
      throw new AppError('CONFLICT', { message: 'کد قالب تکراری است.' });
    }
    return apiData(updated);
  }

  @Delete('templates/:id')
  @HttpCode(200)
  @Permissions('sms.template.manage')
  @ApiOperation({ summary: 'حذف (غیرفعال‌سازی) قالب پیامک' })
  async deleteTemplate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const publicId = requireUuid(id);
    const deleted = await this.repository.softDeleteTemplate(ctx.orgId, ctx.actorId, publicId);
    if (!deleted) throw new AppError('NOT_FOUND', { message: 'قالب یافت نشد.' });
    return apiData({ id: publicId, deleted: true });
  }

  @Get('messages')
  @Permissions('sms.read')
  @ApiOperation({ summary: 'آخرین پیامک‌های ارسالی با فیلتر وضعیت و بازهٔ زمانی' })
  async listMessages(@CurrentTenant() ctx: TenantContext, @Query() query: Record<string, unknown>) {
    const status = textOf(query['status']);
    if (status.length > 0 && !(MESSAGE_STATUSES as readonly string[]).includes(status)) {
      throw new AppError('VALIDATION_ERROR', { message: 'وضعیت پیامک معتبر نیست.' });
    }
    const from = parseDateQuery(query['from'], 'from');
    const to = parseDateQuery(query['to'], 'to');
    const limit = limitOf(query['limit']);
    const filter: SmsMessageFilter = {
      ...(status.length === 0 ? {} : { status }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      limit,
    };
    const items = await this.repository.listMessages(ctx.orgId, filter);
    return apiData(items, { pagination: { mode: 'offset', limit, count: items.length } });
  }

  @Get('stats')
  @Permissions('sms.read')
  @ApiOperation({ summary: 'شمارش پیامک‌ها به تفکیک وضعیت در ۷ روز گذشته' })
  async stats(@CurrentTenant() ctx: TenantContext) {
    const to = new Date();
    const from = new Date(to.getTime() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const counts = await this.repository.statusCountsSince(ctx.orgId, from);
    const byStatus: Array<{ status: string; count: number }> = MESSAGE_STATUSES.map((status) => ({
      status,
      count: counts.find((row) => row.status === status)?.count ?? 0,
    }));
    // Never hide unexpected statuses written by an older worker.
    for (const row of counts) {
      if (!MESSAGE_STATUSES.includes(row.status as (typeof MESSAGE_STATUSES)[number])) {
        byStatus.push({ status: row.status, count: row.count });
      }
    }
    const total = byStatus.reduce((sum, row) => sum + row.count, 0);
    return apiData({
      windowDays: STATS_WINDOW_DAYS,
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      byStatus,
    });
  }

  @Post('test')
  @HttpCode(200)
  @Permissions('sms.send')
  @ApiOperation({ summary: 'ارسال آزمایشی پیامک از طریق سرویس Limo و ثبت آن' })
  async sendTest(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    if (this.sms.mode === 'mock') {
      throw new AppError('NOT_IMPLEMENTED', {
        message:
          'حالت mock فعال است (SMS_MODE=mock)؛ ارسال آزمایشی واقعی انجام نمی‌شود. برای ارسال واقعی SMS_MODE=limo و LIMO_API_KEY را تنظیم کنید.',
        messageKey: 'error.sms_mock_mode',
      });
    }
    const payload = bodyOf(body);
    const mobile = textOf(payload['mobile']);
    const text = textOf(payload['body']);
    if (normalizeIranianMobile(mobile) === null) {
      throw new AppError('VALIDATION_ERROR', { message: 'شمارهٔ موبایل معتبر نیست.' });
    }
    if (text.length === 0 || text.length > 500) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'متن پیامک باید بین ۱ تا ۵۰۰ نویسه باشد.',
      });
    }
    const result = await this.sms.sendAdHoc({
      organizationId: ctx.orgId.toString(),
      userId: ctx.actorId === null ? null : ctx.actorId.toString(),
      mobile,
      message: text,
      purpose: 'test',
      ...(ctx.ip === undefined ? {} : { ip: ctx.ip }),
    });
    const stored = await this.repository.findMessage(ctx.orgId, result.smsMessageId);
    return apiData({
      ok: true,
      smsMessageId: result.smsMessageId,
      providerMessageId: result.providerMessageId,
      provider: stored?.provider ?? 'limo_sms',
      status: stored?.status ?? 'sent',
    });
  }
}

function parseDateQuery(value: unknown, field: string): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('VALIDATION_ERROR', { message: `${field} تاریخ معتبری نیست.` });
  }
  return parsed.toISOString();
}

function limitOf(value: unknown): number {
  const parsed = Number(value ?? 100);
  return Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.trunc(parsed))) : 100;
}
