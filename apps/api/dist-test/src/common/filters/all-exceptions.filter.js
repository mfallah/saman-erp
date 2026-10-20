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
exports.AllExceptionsFilter = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@saman/shared");
const zod_1 = require("zod");
const nestjs_zod_1 = require("nestjs-zod");
const logger_token_1 = require("../logging/logger.token");
const request_id_1 = require("../request-id/request-id");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}
function mapException(exception) {
    if ((0, shared_1.isAppError)(exception)) {
        return { appError: exception, isUnexpected: false };
    }
    if (exception instanceof nestjs_zod_1.ZodValidationException) {
        return { appError: (0, shared_1.appErrorFromZod)(exception.getZodError()), isUnexpected: false };
    }
    if (exception instanceof zod_1.ZodError) {
        return { appError: (0, shared_1.appErrorFromZod)(exception), isUnexpected: false };
    }
    if (exception instanceof common_1.HttpException) {
        const status = exception.getStatus();
        const response = exception.getResponse();
        const safeDetails = [];
        if (typeof response === 'object' && response !== null) {
            const message = response.message;
            if (Array.isArray(message)) {
                for (const item of message) {
                    if (typeof item === 'string')
                        safeDetails.push({ field: item, rule: 'invalid' });
                }
            }
        }
        const code = status === 429 ? 'RATE_LIMITED' : (0, shared_1.errorCodeFromHttpStatus)(status);
        const retryAfter = readRetryAfter(response);
        return {
            appError: new shared_1.AppError(code, {
                details: safeDetails,
                ...(retryAfter === undefined ? {} : { retryAfter }),
            }),
            isUnexpected: status >= 500,
        };
    }
    return { appError: new shared_1.AppError('INTERNAL'), isUnexpected: true };
}
function readRetryAfter(response) {
    if (typeof response !== 'object' || response === null)
        return undefined;
    const value = response.retryAfter;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}
function safeErrorCode(exception) {
    if (!(exception instanceof Error))
        return undefined;
    const code = exception.code;
    return typeof code === 'string' ? code.slice(0, 100) : undefined;
}
/**
 * Contract-wide error filter (`API.md` §1.4): emits
 * `{ error: { code, message, messageKey, details?, requestId, retryAfter?, upstream? } }`
 * with the echoed `X-Request-ID`, never a stack trace, SQL or internal id.
 */
let AllExceptionsFilter = class AllExceptionsFilter {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    catch(exception, host) {
        const http = host.switchToHttp();
        const request = http.getRequest();
        const reply = http.getResponse();
        const requestId = (0, request_id_1.getRequestId)(request);
        const { appError, isUnexpected } = mapException(exception);
        const base = {
            requestId,
            code: appError.code,
            route: request.url,
            method: request.method,
        };
        if (isUnexpected || appError.httpStatus >= 500) {
            this.logger.error({
                ...base,
                err: serializeError(exception),
            }, 'unhandled_exception');
        }
        else {
            this.logger.debug(base, 'request_failed');
        }
        if (reply.sent) {
            return;
        }
        reply.header('X-Request-ID', requestId);
        if (appError.retryAfter !== undefined && (0, shared_1.isRetryableCode)(appError.code)) {
            reply.header('Retry-After', String(appError.retryAfter));
        }
        const envelope = appError.toEnvelope(requestId);
        if (isUuid(requestId)) {
            // requestId is echoed in the envelope; the header carries it even for 500s.
        }
        reply.status(appError.httpStatus).send(envelope);
    }
};
exports.AllExceptionsFilter = AllExceptionsFilter;
exports.AllExceptionsFilter = AllExceptionsFilter = __decorate([
    (0, common_1.Catch)(),
    __param(0, (0, common_1.Inject)(logger_token_1.LOGGER)),
    __metadata("design:paramtypes", [Object])
], AllExceptionsFilter);
function serializeError(exception) {
    if (!(exception instanceof Error))
        return undefined;
    return {
        name: exception.name,
        message: exception.message,
        stack: exception.stack,
        code: safeErrorCode(exception),
    };
}
