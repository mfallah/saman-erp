import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { LOGGER, type AppLogger } from '../logging/logger.token';
import { getRequestId } from '../request-id/request-id';

/**
 * Structured request logging (`ARCHITECTURE.md` §12) using the single pino logger,
 * plus `Server-Timing` for GETs outside production (`API.md` §1.2).
 * Bodies/PII are never logged; redaction also applies to any nested secrets.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const route = request.routeOptions?.url ?? request.url;
        const requestId = getRequestId(request);
        if (this.config.appEnv !== 'production' && request.method === 'GET') {
          try {
            reply.header('Server-Timing', `app;dur=${durationMs.toFixed(1)}`);
          } catch {
            // Headers may already be flushed for streamed responses.
          }
        }
        this.logger.info(
          {
            requestId,
            method: request.method,
            route,
            status: reply.statusCode,
            durationMs: Math.round(durationMs * 10) / 10,
          },
          'request_completed',
        );
      }),
    );
  }
}
