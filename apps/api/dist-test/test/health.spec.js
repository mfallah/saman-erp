"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
/**
 * These specs boot the real Nest app with live DB/Redis connectivity checks.
 * They run in CI (TEST_HTTP_APP=1 with services); locally without dependencies
 * they are skipped instead of failing the unit-test gate.
 */
const HTTP_TESTS_SKIP = process.env['TEST_HTTP_APP'] === '1' ? false : 'set TEST_HTTP_APP=1 (requires PostgreSQL + Redis)';
const expect_1 = require("./support/expect");
const supertest_1 = __importDefault(require("supertest"));
const test_app_1 = require("./support/test-app");
(0, node_test_1.describe)('GET /health/live', { skip: HTTP_TESTS_SKIP }, () => {
    (0, node_test_1.it)('reports liveness in the standard success envelope', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        try {
            const response = await (0, supertest_1.default)(url).get('/health/live').expect(200);
            (0, expect_1.expect)(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            (0, expect_1.expect)(response.body.data.status).toBe('ok');
            (0, expect_1.expect)(typeof response.body.data.uptimeSeconds).toBe('number');
            (0, expect_1.expect)(response.body.meta.requestId).toBe(response.headers['x-request-id']);
        }
        finally {
            await app.close();
        }
    });
    (0, node_test_1.it)('honours a valid client X-Request-ID and echoes it', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        const requestId = '0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11';
        try {
            const response = await (0, supertest_1.default)(url).get('/health/live').set('X-Request-ID', requestId).expect(200);
            (0, expect_1.expect)(response.headers['x-request-id']).toBe(requestId);
            (0, expect_1.expect)(response.body.meta.requestId).toBe(requestId);
        }
        finally {
            await app.close();
        }
    });
});
(0, node_test_1.describe)('GET /health/ready', { skip: HTTP_TESTS_SKIP }, () => {
    (0, node_test_1.it)('returns 200 when database and redis answer', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        try {
            const response = await (0, supertest_1.default)(url).get('/health/ready').expect(200);
            (0, expect_1.expect)(response.body.data.status).toBe('ok');
            (0, expect_1.expect)(response.body.data.checks.db.status).toBe('up');
            (0, expect_1.expect)(response.body.data.checks.redis.status).toBe('up');
            (0, expect_1.expect)(response.body.data.checks.s3.status).toBe('skipped');
        }
        finally {
            await app.close();
        }
    });
    (0, node_test_1.it)('returns the SERVICE_DEGRADED error envelope when dependencies are down', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)({ db: (0, test_app_1.failingDatabase)(), redis: (0, test_app_1.failingRedis)() });
        try {
            const response = await (0, supertest_1.default)(url).get('/health/ready').expect(503);
            (0, expect_1.expect)(response.body.error.code).toBe('SERVICE_DEGRADED');
            (0, expect_1.expect)(response.body.error.requestId).toBe(response.headers['x-request-id']);
            (0, expect_1.expect)(response.headers['retry-after']).toBe('5');
            (0, expect_1.expect)(response.body.error.details).toEqual((0, expect_1.arrayContaining)([(0, expect_1.objectContaining)({ rule: 'db' })]));
            (0, expect_1.expect)(response.body.error.details).toEqual((0, expect_1.arrayContaining)([(0, expect_1.objectContaining)({ rule: 'redis' })]));
        }
        finally {
            await app.close();
        }
    });
});
(0, node_test_1.describe)('GET /health/version', { skip: HTTP_TESTS_SKIP }, () => {
    (0, node_test_1.it)('exposes build/env information without secrets', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        try {
            const response = await (0, supertest_1.default)(url).get('/health/version').expect(200);
            (0, expect_1.expect)(typeof response.body.data.version).toBe('string');
            (0, expect_1.expect)(response.body.data.env).toBe('test');
            (0, expect_1.expect)(response.body.data).toHaveProperty('commit');
        }
        finally {
            await app.close();
        }
    });
});
(0, node_test_1.describe)('contract fallbacks', { skip: HTTP_TESTS_SKIP }, () => {
    (0, node_test_1.it)('wraps the 404 route-not-found in the API error envelope', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        try {
            const response = await (0, supertest_1.default)(url).get('/api/v1/does-not-exist').expect(404);
            (0, expect_1.expect)(response.body.error.code).toBe('NOT_FOUND');
            (0, expect_1.expect)(response.body.error.messageKey).toBe('error.not_found');
            (0, expect_1.expect)(typeof response.body.error.requestId).toBe('string');
            (0, expect_1.expect)(response.headers['x-request-id']).toBe(response.body.error.requestId);
            (0, expect_1.expect)(response.body).not.toHaveProperty('success');
        }
        finally {
            await app.close();
        }
    });
    (0, node_test_1.it)('keeps health and metrics outside the /api/v1 prefix', async () => {
        const { app, url } = await (0, test_app_1.createTestApp)();
        try {
            await (0, supertest_1.default)(url).get('/api/v1/health/live').expect(404);
            await (0, supertest_1.default)(url).get('/health/live').expect(200);
        }
        finally {
            await app.close();
        }
    });
});
