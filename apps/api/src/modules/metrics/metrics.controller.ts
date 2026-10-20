import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppError } from '@saman/shared';
import type { FastifyReply } from 'fastify';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { Public } from '../../common/decorators/public.decorator';
import { timingSafeEqualStrings } from '../../common/providers/crypto.service';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint (`GET /metrics`, outside the `/api/v1` prefix).
 * `API.md` §4.19: requires the `METRICS_TOKEN` bearer when configured; otherwise
 * the edge/reverse proxy restricts it to the loopback network.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const expectedToken = this.config.metricsToken;
    if (expectedToken !== undefined && expectedToken !== '') {
      const provided = authorization?.startsWith('Bearer ') === true ? authorization.slice(7) : '';
      if (!timingSafeEqualStrings(provided, expectedToken)) {
        throw new AppError('UNAUTHENTICATED', { messageKey: 'metrics.token_invalid' });
      }
    }
    const { body, contentType } = await this.metrics.render();
    reply.header('Content-Type', contentType).header('Cache-Control', 'no-store');
    return body;
  }
}
