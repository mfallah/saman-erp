/** Journal HTTP surface (`API.md §4.11`): draft → submit → approve → post → reverse. */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantContext } from '../../../common/contracts';
import { JournalService } from '../journal/journal.service';
import type { JournalLineDto } from '../journal/journal.service';
import { AppendJournalLineSchema, CreateJournalSchema, JournalFilterSchema, ReverseJournalSchema, UpdateJournalSchema, parseDto, toBigInt, toMoney } from '../dto';
import { RequirePermissions, Tenant } from '../http/decorators';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';
import { journalOut } from '../http/serialise';

async function linesOf(
  ctx: TenantContext,
  journals: JournalService,
  lines: readonly {
    accountId: string | number;
    debit: string;
    credit: string;
    description?: string;
    partnerType?: string;
    partnerId?: string | number;
    taxRateId?: string | number;
  }[],
): Promise<JournalLineDto[]> {
  const resolved = await Promise.all(
    lines.map(async (line) => ({
      accountId: await journals.resolveAccountId(ctx, line.accountId),
      debit: toMoney(line.debit),
      credit: toMoney(line.credit),
      ...(line.description === undefined ? {} : { description: line.description }),
      ...(line.partnerType === undefined ? {} : { partnerType: line.partnerType }),
      ...(line.partnerId === undefined ? {} : { partnerId: toBigInt(line.partnerId) }),
      ...(line.taxRateId === undefined ? {} : { taxRateId: toBigInt(line.taxRateId) }),
    })),
  );
  return resolved;
}

@ApiTags('accounting')
@Controller('accounting/journal-entries')
export class JournalController {
  constructor(private readonly journals: JournalService) {}

  @Get()
  @RequirePermissions('accounting.journal.read')
  @ApiOperation({ summary: 'فهرست اسناد حسابداری' })
  async list(@Tenant() ctx: TenantContext, @Query() query: unknown): Promise<{ data: unknown[] }> {
    const filter = parseDto(JournalFilterSchema, query);
    const rows = await this.journals.list(ctx, {
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.type === undefined ? {} : { entryType: filter.type }),
      ...(filter.fiscalYearId === undefined ? {} : { fiscalYearId: toBigInt(filter.fiscalYearId) }),
      ...(filter.periodId === undefined ? {} : { periodId: toBigInt(filter.periodId) }),
      ...(filter.dateFrom === undefined ? {} : { dateFrom: filter.dateFrom }),
      ...(filter.dateTo === undefined ? {} : { dateTo: filter.dateTo }),
      ...(filter.sourceType === undefined ? {} : { sourceType: filter.sourceType }),
      ...(filter.sourceId === undefined ? {} : { sourceId: toBigInt(filter.sourceId) }),
      page: {
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
      },
    });
    return { data: rows.map(journalOut) };
  }

  @Post()
  @RequirePermissions('accounting.journal.create')
  @ApiOperation({ summary: 'ایجاد سند دستی پیش‌نویس' })
  async create(@Tenant() ctx: TenantContext, @Body() body: unknown): Promise<{ data: unknown }> {
    const dto = parseDto(CreateJournalSchema, body);
    const journal = await this.journals.createDraft(ctx, {
      date: dto.date,
      description: dto.description,
      ...(dto.entryType === undefined ? {} : { entryType: dto.entryType }),
      lines: await linesOf(ctx, this.journals, dto.lines),
    });
    return { data: journalOut(journal) };
  }

  @Get(':id')
  @RequirePermissions('accounting.journal.read')
  @ApiOperation({ summary: 'جزئیات سند' })
  async get(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: journalOut(await this.journals.get(ctx, await this.journals.resolveId(ctx, id))) };
  }

  @Patch(':id')
  @RequirePermissions('accounting.journal.update')
  @ApiOperation({ summary: 'ویرایش پیش‌نویس' })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('version') version?: string,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(UpdateJournalSchema, body);
    const journal = await this.journals.updateDraft(
      ctx,
      await this.journals.resolveId(ctx, id),
      {
        ...(dto.description === undefined ? {} : { description: dto.description }),
        ...(dto.date === undefined ? {} : { date: dto.date }),
        ...(dto.lines === undefined ? {} : { lines: await linesOf(ctx, this.journals, dto.lines) }),
      },
      version === undefined ? 0 : Number(version),
    );
    return { data: journalOut(journal) };
  }

  @Delete(':id')
  @RequirePermissions('accounting.journal.delete')
  @ApiOperation({ summary: 'حذف پیش‌نویس' })
  async remove(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.journals.deleteDraft(ctx, await this.journals.resolveId(ctx, id));
  }

  @Post(':id/submit')
  @RequirePermissions('accounting.journal.update')
  @ApiOperation({ summary: 'ارسال برای تأیید' })
  async submit(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown }> {
    return { data: journalOut(await this.journals.submit(ctx, await this.journals.resolveId(ctx, id))) };
  }

  @RequireStepUp('accounting.journal.approve')
  @Post(':id/approve')
  @RequirePermissions('accounting.journal.approve')
  @ApiOperation({ summary: 'تأیید سند (تفکیک وظایف)' })
  async approve(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ): Promise<{ data: unknown }> {
    return { data: journalOut(await this.journals.approve(ctx, await this.journals.resolveId(ctx, id), body.note)) };
  }

  @RequireStepUp('accounting.journal.post')
  @Post(':id/post')
  @RequirePermissions('accounting.journal.post')
  @ApiOperation({ summary: 'ثبت سند: شماره، مانده‌ها و قفل سطرها' })
  async post(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() _body: { postDate?: string },
  ): Promise<{ data: unknown }> {
    // Any `postDate` in the body is ignored: the period always comes from the
    // stored entry date (TD-19), resolved and locked inside the posting tx.
    return { data: journalOut(await this.journals.post(ctx, await this.journals.resolveId(ctx, id))) };
  }

  @RequireStepUp('accounting.journal.reverse')
  @Post(':id/reverse')
  @RequirePermissions('accounting.journal.reverse')
  @ApiOperation({ summary: 'ایجاد سند برگشتی (بدون ویرایش سند ثبت‌شده)' })
  async reverse(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(ReverseJournalSchema, body);
    const journal = await this.journals.reverse(ctx, await this.journals.resolveId(ctx, id), {
      reason: dto.reason,
      ...(dto.reversalDate === undefined ? {} : { reversalDate: dto.reversalDate }),
    });
    return { data: journalOut(journal) };
  }

  @Get(':id/lines')
  @RequirePermissions('accounting.journal.read')
  @ApiOperation({ summary: 'سطرهای سند' })
  async lines(@Tenant() ctx: TenantContext, @Param('id') id: string): Promise<{ data: unknown[] }> {
    const journal = await this.journals.get(ctx, await this.journals.resolveId(ctx, id));
    return { data: journalOut(journal)['lines'] as unknown[] };
  }

  @Post(':id/lines')
  @RequirePermissions('accounting.journal.update')
  @ApiOperation({ summary: 'افزودن سطر به پیش‌نویس' })
  async appendLine(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('version') version?: string,
  ): Promise<{ data: unknown }> {
    const dto = parseDto(AppendJournalLineSchema, body);
    const current = await this.journals.get(ctx, await this.journals.resolveId(ctx, id));
    const lines = [
      ...current.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debitAmount,
        credit: line.creditAmount,
      })),
      ...(await linesOf(ctx, this.journals, [dto])),
    ];
    const journal = await this.journals.updateDraft(
      ctx,
      await this.journals.resolveId(ctx, id),
      { lines },
      version === undefined ? current.version : Number(version),
    );
    return { data: journalOut(journal) };
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions('accounting.journal.update')
  @ApiOperation({ summary: 'حذف سطر از پیش‌نویس' })
  async removeLine(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<{ data: unknown }> {
    const current = await this.journals.get(ctx, await this.journals.resolveId(ctx, id));
    const remaining = current.lines
      .filter((line) => line.id.toString() !== lineId)
      .map((line) => ({ accountId: line.accountId, debit: line.debitAmount, credit: line.creditAmount }));
    const journal = await this.journals.updateDraft(ctx, await this.journals.resolveId(ctx, id), { lines: remaining }, current.version);
    return { data: journalOut(journal) };
  }
}
