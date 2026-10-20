"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseInterceptor = exports.ApiPayload = void 0;
exports.apiData = apiData;
const common_1 = require("@nestjs/common");
const operators_1 = require("rxjs/operators");
const request_id_1 = require("../request-id/request-id");
/** Explicit success payload with extra `meta` fields (e.g. pagination). */
class ApiPayload {
    data;
    meta;
    constructor(data, meta) {
        this.data = data;
        this.meta = meta;
    }
}
exports.ApiPayload = ApiPayload;
/** Wraps data with a custom `meta` block (pagination, totals, job refs). */
function apiData(data, meta) {
    return new ApiPayload(data, meta);
}
/** Routes that must not be enveloped (Prometheus exposition, OpenAPI docs). */
function isRawRoute(request) {
    const url = request.url;
    return url.startsWith('/metrics') || url.includes('/docs');
}
function cacheControlFor(request) {
    if (request.url.startsWith('/health'))
        return 'public, max-age=10';
    return 'no-store';
}
/**
 * Success envelope (`API.md` §1.3): `{ data, meta: { requestId, traceId? } }`.
 * `204` and raw routes stay untouched; collections are `[]`, never `null`.
 */
let ResponseInterceptor = class ResponseInterceptor {
    intercept(context, next) {
        const http = context.switchToHttp();
        const request = http.getRequest();
        const reply = http.getResponse();
        reply.header('Cache-Control', cacheControlFor(request));
        return next.handle().pipe((0, operators_1.map)((payload) => {
            if (payload === undefined || reply.statusCode === 204 || isRawRoute(request)) {
                return payload;
            }
            const requestId = (0, request_id_1.getRequestId)(request);
            const traceId = (0, request_id_1.getTraceId)(request);
            const traceMeta = traceId === undefined ? {} : { traceId };
            if (payload instanceof ApiPayload) {
                return {
                    data: payload.data,
                    meta: { requestId, ...traceMeta, ...(payload.meta ?? {}) },
                };
            }
            return { data: payload, meta: { requestId, ...traceMeta } };
        }));
    }
};
exports.ResponseInterceptor = ResponseInterceptor;
exports.ResponseInterceptor = ResponseInterceptor = __decorate([
    (0, common_1.Injectable)()
], ResponseInterceptor);
