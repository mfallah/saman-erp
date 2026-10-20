import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

import { MetricsService } from './metrics.service';

/** Records HTTP histogram/counter metrics with the route pattern (bounded cardinality). */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const route = request.routeOptions?.url ?? 'unmatched';
        if (route === 'unmatched') return;
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        this.metrics.observe(request.method, route, reply.statusCode, durationSeconds);
      }),
    );
  }
}
