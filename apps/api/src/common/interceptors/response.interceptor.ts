import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { getRequestId, getTraceId } from '../request-id/request-id';

/** Explicit success payload with extra `meta` fields (e.g. pagination). */
export class ApiPayload<T> {
  constructor(
    readonly data: T,
    readonly meta?: Record<string, unknown>,
  ) {}
}

/** Wraps data with a custom `meta` block (pagination, totals, job refs). */
export function apiData<T>(data: T, meta?: Record<string, unknown>): ApiPayload<T> {
  return new ApiPayload<T>(data, meta);
}

/** Routes that must not be enveloped (Prometheus exposition, OpenAPI docs). */
function isRawRoute(request: FastifyRequest): boolean {
  const url = request.url;
  return url.startsWith('/metrics') || url.includes('/docs');
}

function cacheControlFor(request: FastifyRequest): string {
  if (request.url.startsWith('/health')) return 'public, max-age=10';
  return 'no-store';
}

/**
 * Success envelope (`API.md` §1.3): `{ data, meta: { requestId, traceId? } }`.
 * `204` and raw routes stay untouched; collections are `[]`, never `null`.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    reply.header('Cache-Control', cacheControlFor(request));

    return next.handle().pipe(
      map((payload: unknown) => {
        if (payload === undefined || reply.statusCode === 204 || isRawRoute(request)) {
          return payload;
        }
        const requestId = getRequestId(request);
        const traceId = getTraceId(request);
        const traceMeta = traceId === undefined ? {} : { traceId };

        // Some controllers return a ready envelope `{ data, pagination? }` (accounting
        // module style). Merge instead of nesting a second `data` layer.
        const envelopeLike =
          payload !== null &&
          typeof payload === 'object' &&
          'data' in (payload as Record<string, unknown>) &&
          Object.keys(payload as Record<string, unknown>).every((key) =>
            ['data', 'meta', 'pagination'].includes(key),
          );
        if (envelopeLike) {
          const record = payload as { data: unknown; meta?: Record<string, unknown>; pagination?: unknown };
          return {
            data: record.data,
            meta: {
              requestId,
              ...traceMeta,
              ...(record.meta ?? {}),
              ...(record.pagination === undefined ? {} : { pagination: record.pagination }),
            },
          };
        }
        if (payload instanceof ApiPayload) {
          return {
            data: payload.data,
            meta: { requestId, ...traceMeta, ...(payload.meta ?? {}) },
          };
        }
        return { data: payload, meta: { requestId, ...traceMeta } };
      }),
    );
  }
}
