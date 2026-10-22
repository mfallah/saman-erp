/**
 * In-app notification inbox for the authenticated user (`API.md` §4.19).
 * Permission-free by design: every query is scoped to the caller's own user id.
 */
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type CurrentActor } from '../../common/decorators/current-context.decorator';
import { AuthenticatedOnly } from '../../common/decorators/authenticated-only.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import type { NotificationRow } from './repositories/notification.repository';
// NotificationsService is a DI value (constructor metadata), not only a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { NotificationsService } from './services/notifications.service';

function limitOf(value: unknown): number {
  const parsed = Number(value ?? 50);
  return Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.trunc(parsed))) : 50;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function notificationView(row: NotificationRow): Record<string, unknown> {
  const link = row.data['link'];
  const createdAt = row.createdAt?.toISOString();
  return {
    id: row.id,
    type: row.eventType,
    titleFa: row.title,
    ...(row.body === null ? {} : { bodyFa: row.body }),
    channel: row.channel,
    severity: row.priority,
    read: row.readAt !== null,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(typeof link === 'string' ? { link } : {}),
  };
}

@ApiTags('notifications')
@ApiBearerAuth()
@AuthenticatedOnly()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'اعلان‌های درون‌برنامه‌ای کاربر جاری' })
  async list(@CurrentUser() user: CurrentActor, @Query() query: Record<string, unknown>) {
    const limit = limitOf(query['limit']);
    const read = query['read'];
    const unreadOnly = query['unreadOnly'] === 'true' || read === 'false' || read === false;
    const type = stringOf(query['type']);
    const items = await this.notifications.list({
      userId: user.id.toString(),
      unreadOnly,
      ...(type === undefined ? {} : { type }),
      limit,
    });
    return apiData(items.map(notificationView), {
      pagination: { mode: 'offset', limit, count: items.length },
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'علامت‌گذاری یک اعلان به‌عنوان خوانده‌شده' })
  async markRead(@CurrentUser() user: CurrentActor, @Param('id') id: string): Promise<void> {
    await this.notifications.markRead(user.id.toString(), id);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'علامت‌گذاری همهٔ اعلان‌های کاربر به‌عنوان خوانده‌شده' })
  async markAllRead(@CurrentUser() user: CurrentActor) {
    const count = await this.notifications.markAllRead(user.id.toString());
    return apiData({ count });
  }
}
