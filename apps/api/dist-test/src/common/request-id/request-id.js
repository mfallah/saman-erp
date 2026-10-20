"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORRELATION_ID_HEADER = exports.REQUEST_ID_HEADER = void 0;
exports.isValidRequestId = isValidRequestId;
exports.resolveRequestId = resolveRequestId;
exports.getRequestId = getRequestId;
exports.getCorrelationId = getCorrelationId;
exports.registerRequestIdHook = registerRequestIdHook;
exports.getTraceId = getTraceId;
const node_crypto_1 = require("node:crypto");
/**
 * Request correlation (`API.md` §1.2): honour a syntactically valid client
 * `X-Request-ID` (UUIDv4/v7), otherwise generate one; always echo it back and
 * keep it available on `request.headers` for the error envelope and audit.
 */
exports.REQUEST_ID_HEADER = 'x-request-id';
exports.CORRELATION_ID_HEADER = 'x-correlation-id';
const UUID_V4_OR_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** UUIDv4/v7 check used to decide whether a client request id is trustworthy. */
function isValidRequestId(value) {
    return typeof value === 'string' && UUID_V4_OR_V7.test(value);
}
/** Returns the honoured client id or a freshly generated UUIDv4. */
function resolveRequestId(headerValue) {
    return isValidRequestId(headerValue) ? headerValue : (0, node_crypto_1.randomUUID)();
}
/** Reads the request id previously stored on the Fastify request. */
function getRequestId(request) {
    const value = request.headers[exports.REQUEST_ID_HEADER];
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : (0, node_crypto_1.randomUUID)();
    }
    return typeof value === 'string' && value.length > 0 ? value : (0, node_crypto_1.randomUUID)();
}
/** Optional business correlation id, echoed only when safe (max 128 chars). */
function getCorrelationId(request) {
    const value = request.headers[exports.CORRELATION_ID_HEADER];
    return typeof value === 'string' && SAFE_CORRELATION_ID.test(value) ? value : undefined;
}
/** Installs the `onRequest` hook that assigns, stores and echoes the request id. */
function registerRequestIdHook(app) {
    app.addHook('onRequest', (request, reply, done) => {
        const requestId = resolveRequestId(request.headers[exports.REQUEST_ID_HEADER]);
        request.headers[exports.REQUEST_ID_HEADER] = requestId;
        reply.header('X-Request-ID', requestId);
        const correlationId = request.headers[exports.CORRELATION_ID_HEADER];
        if (typeof correlationId === 'string' && !SAFE_CORRELATION_ID.test(correlationId)) {
            delete request.headers[exports.CORRELATION_ID_HEADER];
        }
        else if (typeof correlationId === 'string') {
            reply.header('X-Correlation-ID', correlationId);
        }
        done();
    });
}
/** W3C `traceparent` trace id (32 hex chars), when present and well-formed. */
function getTraceId(request) {
    const traceparent = request.headers['traceparent'];
    if (typeof traceparent !== 'string')
        return undefined;
    const parts = traceparent.split('-');
    if (parts.length < 4)
        return undefined;
    const traceId = parts[1];
    return typeof traceId === 'string' && /^[0-9a-f]{32}$/i.test(traceId) ? traceId : undefined;
}
