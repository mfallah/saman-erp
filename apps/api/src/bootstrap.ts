import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError, errorCodeFromHttpStatus, type ErrorCode } from '@saman/shared';

import type { AppConfig } from './config/env.schema';
import type { AppLogger } from './common/logging/logger.token';
import { getRequestId, registerRequestIdHook } from './common/request-id/request-id';

/** JSON body cap for the API; bulk/import endpoints raise it per-route later. */
export const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** Probes and metrics stay outside the versioned prefix (`ARCHITECTURE.md` §12). */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready', 'health/version', 'metrics'] as const;

/** Absolute API base path, e.g. `/api/v1`. */
export function apiBasePath(config: AppConfig): string {
  return `/${config.apiPrefix}/${config.apiVersion}`;
}

/**
 * Preserve the exact raw request body for channel webhooks.
 * HMAC verification is computed over the raw bytes (ADR-0006 revision), so the
 * webhook route prefix is buffered before Fastify parses JSON.
 */
export function registerRawBodyParser(fastify: FastifyInstance): void {
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/api/v1/webhooks/channels/')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks);
    (request as unknown as { rawBody?: Buffer }).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });
}

function registerCorsHook(fastify: FastifyInstance, config: AppConfig): void {
  if (config.appEnv === 'production' || config.corsOrigins.length === 0) {
    // Same-origin in production (`API.md` §1.17); CORS exists for the dev SPA.
    return;
  }
  const allowedOrigins = new Set(config.corsOrigins);
  fastify.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
      return;
    }
    reply
      .header('Access-Control-Allow-Origin', origin)
      .header('Vary', 'Origin')
      .header('Access-Control-Allow-Credentials', 'true')
      .header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      .header(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,Idempotency-Key,If-Match,X-Request-ID,X-Correlation-ID,X-CSRF-Token,X-Requested-With,X-Step-Up-Token',
      )
      .header('Access-Control-Max-Age', '600');
    if (request.method === 'OPTIONS') {
      await reply.status(204).send();
    }
  });
}

function registerContractFallbacks(fastify: FastifyInstance): void {
  // Unmatched routes are handled by Nest's Fastify adapter as a NotFoundException,
  // which flows through `AllExceptionsFilter` and therefore already emits the
  // `{ error }` envelope of API.md §1.4 — overriding the handler is disallowed once
  // the adapter installed it. Pre-Nest failures (bad JSON, body limit, unsupported
  // media type) are mapped here.

  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    let code: ErrorCode;
    if (error.validation !== undefined) {
      code = 'VALIDATION_ERROR';
    } else if (status === 413) {
      code = 'PAYLOAD_TOO_LARGE';
    } else if (status === 415) {
      code = 'UNSUPPORTED_MEDIA_TYPE';
    } else {
      code = errorCodeFromHttpStatus(status);
    }
    const appError = new AppError(code);
    const requestId = getRequestId(request);
    reply
      .status(appError.httpStatus)
      .header('X-Request-ID', requestId)
      .send(appError.toEnvelope(requestId));
  });
}

function registerSwagger(app: NestFastifyApplication, config: AppConfig): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${config.appName} API`)
      .setDescription('Saman ERP REST API — contract: docs/03-api-contract/API.md')
      .setVersion(config.apiVersion.replace(/^v/, ''))
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build(),
  );
  SwaggerModule.setup(`${config.apiPrefix}/${config.apiVersion}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}

/**
 * Applies every cross-cutting concern to the Nest/Fastify application:
 * prefix (except health/metrics), validation pipe, Fastify plugins (helmet,
 * cookie, compression), request id, CORS (non-prod), contract fallbacks and
 * gated OpenAPI docs. Kept separate from `main.ts` so tests build the same app.
 */
export async function configureApp(
  app: NestFastifyApplication,
  config: AppConfig,
  logger: AppLogger,
): Promise<void> {
  app.setGlobalPrefix(`${config.apiPrefix}/${config.apiVersion}`, {
    exclude: [...UNPREFIXED_ROUTES],
  });
  app.useGlobalPipes(new ZodValidationPipe());

  const fastify = app.getHttpAdapter().getInstance();
  registerRequestIdHook(fastify);
  registerRawBodyParser(fastify);
  registerCorsHook(fastify, config);
  registerContractFallbacks(fastify);

  await app.register(helmet, {
    contentSecurityPolicy: false, // CSP is served by the edge for the SPA (API.md §1.17)
    hsts: config.securityHsts
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  await app.register(compress, { threshold: 1024 });

  if (config.docsEnabled) {
    registerSwagger(app, config);
    logger.warn('DOCS_ENABLED=true: OpenAPI UI exposed at the API path (never in production).');
  }
}
