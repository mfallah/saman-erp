"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNPREFIXED_ROUTES = exports.JSON_BODY_LIMIT_BYTES = void 0;
exports.apiBasePath = apiBasePath;
exports.configureApp = configureApp;
const cookie_1 = __importDefault(require("@fastify/cookie"));
const compress_1 = __importDefault(require("@fastify/compress"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const swagger_1 = require("@nestjs/swagger");
const nestjs_zod_1 = require("nestjs-zod");
const shared_1 = require("@saman/shared");
const request_id_1 = require("./common/request-id/request-id");
/** JSON body cap for the API; bulk/import endpoints raise it per-route later. */
exports.JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
/** Probes and metrics stay outside the versioned prefix (`ARCHITECTURE.md` §12). */
exports.UNPREFIXED_ROUTES = ['health/live', 'health/ready', 'health/version', 'metrics'];
/** Absolute API base path, e.g. `/api/v1`. */
function apiBasePath(config) {
    return `/${config.apiPrefix}/${config.apiVersion}`;
}
function registerCorsHook(fastify, config) {
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
            .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,If-Match,X-Request-ID,X-Correlation-ID,X-CSRF-Token,X-Requested-With,X-Step-Up-Token')
            .header('Access-Control-Max-Age', '600');
        if (request.method === 'OPTIONS') {
            await reply.status(204).send();
        }
    });
}
function registerContractFallbacks(fastify) {
    // Unmatched routes are handled by Nest's Fastify adapter as a NotFoundException,
    // which flows through `AllExceptionsFilter` and therefore already emits the
    // `{ error }` envelope of API.md §1.4 — overriding the handler is disallowed once
    // the adapter installed it. Pre-Nest failures (bad JSON, body limit, unsupported
    // media type) are mapped here.
    fastify.setErrorHandler((error, request, reply) => {
        const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
        let code;
        if (error.validation !== undefined) {
            code = 'VALIDATION_ERROR';
        }
        else if (status === 413) {
            code = 'PAYLOAD_TOO_LARGE';
        }
        else if (status === 415) {
            code = 'UNSUPPORTED_MEDIA_TYPE';
        }
        else {
            code = (0, shared_1.errorCodeFromHttpStatus)(status);
        }
        const appError = new shared_1.AppError(code);
        const requestId = (0, request_id_1.getRequestId)(request);
        reply
            .status(appError.httpStatus)
            .header('X-Request-ID', requestId)
            .send(appError.toEnvelope(requestId));
    });
}
function registerSwagger(app, config) {
    const document = swagger_1.SwaggerModule.createDocument(app, new swagger_1.DocumentBuilder()
        .setTitle(`${config.appName} API`)
        .setDescription('Saman ERP REST API — contract: docs/03-api-contract/API.md')
        .setVersion(config.apiVersion.replace(/^v/, ''))
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .build());
    swagger_1.SwaggerModule.setup(`${config.apiPrefix}/${config.apiVersion}/docs`, app, document, {
        swaggerOptions: { persistAuthorization: true },
    });
}
/**
 * Applies every cross-cutting concern to the Nest/Fastify application:
 * prefix (except health/metrics), validation pipe, Fastify plugins (helmet,
 * cookie, compression), request id, CORS (non-prod), contract fallbacks and
 * gated OpenAPI docs. Kept separate from `main.ts` so tests build the same app.
 */
async function configureApp(app, config, logger) {
    app.setGlobalPrefix(`${config.apiPrefix}/${config.apiVersion}`, {
        exclude: [...exports.UNPREFIXED_ROUTES],
    });
    app.useGlobalPipes(new nestjs_zod_1.ZodValidationPipe());
    const fastify = app.getHttpAdapter().getInstance();
    (0, request_id_1.registerRequestIdHook)(fastify);
    registerCorsHook(fastify, config);
    registerContractFallbacks(fastify);
    await app.register(helmet_1.default, {
        contentSecurityPolicy: false, // CSP is served by the edge for the SPA (API.md §1.17)
        hsts: config.securityHsts
            ? { maxAge: 31_536_000, includeSubDomains: true }
            : false,
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginResourcePolicy: { policy: 'same-site' },
    });
    await app.register(cookie_1.default);
    await app.register(compress_1.default, { threshold: 1024 });
    if (config.docsEnabled) {
        registerSwagger(app, config);
        logger.warn('DOCS_ENABLED=true: OpenAPI UI exposed at the API path (never in production).');
    }
}
