/**
 * Inbound webhook HTTP surface (API.md §6.1 / §4.19).
 *
 * Registered under `/api/v1/webhooks/channels/...`. The route is public by
 * design: authentication is the HMAC signature, not a JWT. The foundation must
 * (a) recognise the foundation `@Public()` metadata, and (b) capture the raw body before JSON
 * parsing (`rawBody`). Both are exported here as integration contracts.
 */
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  SetMetadata,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '@saman/shared';
import { Public } from '../../../common/decorators/public.decorator';
import type { ChannelWebhookService } from '../services/channel-webhook.service';

export const RAW_BODY_ROUTE_KEY = 'saman:raw-body';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer | string;
}

function extractRawBody(request: RawBodyRequest): Buffer {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
  if (typeof request.rawBody === 'string') return Buffer.from(request.rawBody, 'utf8');
  const body: unknown = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  throw new AppError('INTERNAL', {
    message: 'بدنهٔ خام درخواست در دسترس نیست.',
    messageKey: 'error.raw_body_unavailable',
  });
}

@Controller('webhooks/channels')
export class ChannelWebhookController {
  constructor(private readonly webhooks: ChannelWebhookService) {}

  @Post(':channelCode')
  @HttpCode(200)
  @Public()
  @SetMetadata(RAW_BODY_ROUTE_KEY, true)
  async receive(
    @Param('channelCode') channelCode: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() request: RawBodyRequest,
  ): Promise<{ received: true; duplicate: boolean }> {
    return this.webhooks.receive({
      channelCode,
      headers,
      rawBody: extractRawBody(request),
      ...(request.ip === undefined ? {} : { ip: request.ip }),
    });
  }

  @Post(':channelCode/:accountPublicId')
  @HttpCode(200)
  @Public()
  @SetMetadata(RAW_BODY_ROUTE_KEY, true)
  async receiveForAccount(
    @Param('channelCode') channelCode: string,
    @Param('accountPublicId') accountPublicId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() request: RawBodyRequest,
  ): Promise<{ received: true; duplicate: boolean }> {
    return this.webhooks.receive({
      channelCode,
      accountPublicId,
      headers,
      rawBody: extractRawBody(request),
      ...(request.ip === undefined ? {} : { ip: request.ip }),
    });
  }
}

@Controller('webhooks')
export class WebhookHealthController {
  constructor(private readonly webhooks: ChannelWebhookService) {}

  @Get('health')
  @Public()
  async health(): Promise<{
    channels: readonly { code: string; secretConfigured: boolean; lastEventAt: Date | null }[];
  }> {
    return { channels: await this.webhooks.health() };
  }
}
