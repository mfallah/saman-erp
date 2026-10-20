import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AppError,
  appErrorFromZod,
  errorCodeFromHttpStatus,
  isAppError,
  isRetryableCode,
  type ErrorCode,
  type ErrorDetail,
} from '@saman/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ZodValidationException } from 'nestjs-zod';

import { LOGGER, type AppLogger } from '../logging/logger.token';
import { getRequestId } from '../request-id/request-id';

interface MappedError {
  readonly appError: AppError;
  readonly isUnexpected: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function mapException(exception: unknown): MappedError {
  if (isAppError(exception)) {
    return { appError: exception, isUnexpected: false };
  }
  if (exception instanceof ZodValidationException) {
    return { appError: appErrorFromZod(exception.getZodError() as ZodError), isUnexpected: false };
  }
  if (exception instanceof ZodError) {
    return { appError: appErrorFromZod(exception), isUnexpected: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const safeDetails: ErrorDetail[] = [];
    if (typeof response === 'object' && response !== null) {
      const message = (response as { message?: unknown }).message;
      if (Array.isArray(message)) {
        for (const item of message) {
          if (typeof item === 'string') safeDetails.push({ field: item, rule: 'invalid' });
        }
      }
    }
    const code: ErrorCode = status === 429 ? 'RATE_LIMITED' : errorCodeFromHttpStatus(status);
    const retryAfter = readRetryAfter(response);
    return {
      appError: new AppError(code, {
        details: safeDetails,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }),
      isUnexpected: status >= 500,
    };
  }
  return { appError: new AppError('INTERNAL'), isUnexpected: true };
}

function readRetryAfter(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const value = (response as { retryAfter?: unknown }).retryAfter;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

function safeErrorCode(exception: unknown): string | undefined {
  if (!(exception instanceof Error)) return undefined;
  const code = (exception as { code?: unknown }).code;
  return typeof code === 'string' ? code.slice(0, 100) : undefined;
}

/**
 * Contract-wide error filter (`API.md` §1.4): emits
 * `{ error: { code, message, messageKey, details?, requestId, retryAfter?, upstream? } }`
 * with the echoed `X-Request-ID`, never a stack trace, SQL or internal id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = getRequestId(request);
    const { appError, isUnexpected } = mapException(exception);

    const base = {
      requestId,
      code: appError.code,
      route: request.url,
      method: request.method,
    };
    if (isUnexpected || appError.httpStatus >= 500) {
      this.logger.error(
        {
          ...base,
          err: serializeError(exception),
        },
        'unhandled_exception',
      );
    } else {
      this.logger.debug(base, 'request_failed');
    }

    if (reply.sent) {
      return;
    }
    reply.header('X-Request-ID', requestId);
    if (appError.retryAfter !== undefined && isRetryableCode(appError.code)) {
      reply.header('Retry-After', String(appError.retryAfter));
    }
    const envelope = appError.toEnvelope(requestId);
    if (isUuid(requestId)) {
      // requestId is echoed in the envelope; the header carries it even for 500s.
    }
    reply.status(appError.httpStatus).send(envelope);
  }
}

function serializeError(exception: unknown): Record<string, unknown> | undefined {
  if (!(exception instanceof Error)) return undefined;
  return {
    name: exception.name,
    message: exception.message,
    stack: exception.stack,
    code: safeErrorCode(exception),
  };
}
