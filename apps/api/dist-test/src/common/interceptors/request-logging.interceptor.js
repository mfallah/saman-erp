"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestLoggingInterceptor = void 0;
const common_1 = require("@nestjs/common");
const operators_1 = require("rxjs/operators");
const env_schema_1 = require("../../config/env.schema");
const logger_token_1 = require("../logging/logger.token");
const request_id_1 = require("../request-id/request-id");
/**
 * Structured request logging (`ARCHITECTURE.md` §12) using the single pino logger,
 * plus `Server-Timing` for GETs outside production (`API.md` §1.2).
 * Bodies/PII are never logged; redaction also applies to any nested secrets.
 */
let RequestLoggingInterceptor = class RequestLoggingInterceptor {
    logger;
    config;
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
    }
    intercept(context, next) {
        const http = context.switchToHttp();
        const request = http.getRequest();
        const reply = http.getResponse();
        const startedAt = process.hrtime.bigint();
        return next.handle().pipe((0, operators_1.finalize)(() => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            const route = request.routeOptions?.url ?? request.url;
            const requestId = (0, request_id_1.getRequestId)(request);
            if (this.config.appEnv !== 'production' && request.method === 'GET') {
                try {
                    reply.header('Server-Timing', `app;dur=${durationMs.toFixed(1)}`);
                }
                catch {
                    // Headers may already be flushed for streamed responses.
                }
            }
            this.logger.info({
                requestId,
                method: request.method,
                route,
                status: reply.statusCode,
                durationMs: Math.round(durationMs * 10) / 10,
            }, 'request_completed');
        }));
    }
};
exports.RequestLoggingInterceptor = RequestLoggingInterceptor;
exports.RequestLoggingInterceptor = RequestLoggingInterceptor = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(logger_token_1.LOGGER)),
    __param(1, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [Object, Object])
], RequestLoggingInterceptor);
