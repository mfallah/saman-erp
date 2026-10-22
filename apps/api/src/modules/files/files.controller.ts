/**
 * File upload surface (`API.md` §4.19). Object storage is not configured in this
 * build, so uploads fail closed with a stable `NOT_IMPLEMENTED` response rather
 * than handing the client an unusable presigned URL.
 */
import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppError } from '@saman/shared';

import { Permissions } from '../../common/decorators/permissions.decorator';

function filesNotConfigured(): AppError {
  return new AppError('NOT_IMPLEMENTED', {
    message: 'فضای ذخیره‌سازی فایل پیکربندی نشده است.',
    messageKey: 'files.not_configured',
    details: [{ code: 'FILES_NOT_CONFIGURED' }],
  });
}

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  @Post('uploads')
  @HttpCode(201)
  @Permissions('file.create')
  @ApiOperation({ summary: 'درخواست آدرس بارگذاری فایل (ذخیره‌سازی پیکربندی نشده است)' })
  async createUpload(): Promise<never> {
    throw filesNotConfigured();
  }

  @Post('uploads/:fileId/complete')
  @HttpCode(200)
  @Permissions('file.create')
  @ApiOperation({ summary: 'تأیید پایان بارگذاری فایل (ذخیره‌سازی پیکربندی نشده است)' })
  async completeUpload(): Promise<never> {
    throw filesNotConfigured();
  }
}
