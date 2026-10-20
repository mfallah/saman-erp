"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeTestConfig = makeTestConfig;
exports.silentLogger = silentLogger;
exports.healthyDatabase = healthyDatabase;
exports.failingDatabase = failingDatabase;
exports.healthyRedis = healthyRedis;
exports.failingRedis = failingRedis;
exports.createTestApp = createTestApp;
const common_1 = require("@nestjs/common");
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const core_2 = require("@nestjs/core");
const platform_fastify_1 = require("@nestjs/platform-fastify");
const pino_1 = __importDefault(require("pino"));
const env_schema_1 = require("../../src/config/env.schema");
const contracts_1 = require("../../src/common/contracts");
const redis_provider_1 = require("../../src/common/providers/redis.provider");
const logger_token_1 = require("../../src/common/logging/logger.token");
const all_exceptions_filter_1 = require("../../src/common/filters/all-exceptions.filter");
const permissions_guard_1 = require("../../src/common/guards/permissions.guard");
const request_logging_interceptor_1 = require("../../src/common/interceptors/request-logging.interceptor");
const response_interceptor_1 = require("../../src/common/interceptors/response.interceptor");
const bootstrap_1 = require("../../src/bootstrap");
const health_controller_1 = require("../../src/modules/health/health.controller");
const health_service_1 = require("../../src/modules/health/health.service");
/** Valid test environment: `loadConfig` defaults + test overrides (guards off). */
function makeTestConfig(overrides = {}) {
    return (0, env_schema_1.loadConfig)({ APP_ENV: 'test', NODE_ENV: 'test', LOG_LEVEL: 'error', ...overrides });
}
function silentLogger() {
    return (0, pino_1.default)({ level: 'silent' });
}
function healthyDatabase() {
    const query = () => Promise.resolve([{ ok: 1 }]);
    return query;
}
function failingDatabase() {
    const query = () => Promise.reject(new Error('database down'));
    return query;
}
function healthyRedis() {
    return { ping: () => Promise.resolve('PONG') };
}
function failingRedis() {
    return { ping: () => Promise.reject(new Error('redis down')) };
}
/**
 * Boots the same global wiring as `main.ts` against a mocked platform (no real
 * DB/Redis) without `@nestjs/testing`: a runtime module class holds the mocks.
 */
async function createTestApp(options = {}) {
    const config = options.config ?? makeTestConfig();
    const mocks = {
        db: options.db ?? healthyDatabase(),
        redis: options.redis ?? healthyRedis(),
        logger: silentLogger(),
    };
    // Runtime module class holds the mocks; no @nestjs/testing dependency.
    class TestAppModule {
    }
    (0, common_1.Module)({
        controllers: [health_controller_1.HealthController],
        providers: [
            health_service_1.HealthService,
            { provide: env_schema_1.APP_CONFIG, useValue: config },
            { provide: contracts_1.DB, useValue: mocks.db },
            { provide: redis_provider_1.REDIS, useValue: mocks.redis },
            { provide: logger_token_1.LOGGER, useValue: mocks.logger },
            { provide: core_2.APP_FILTER, useClass: all_exceptions_filter_1.AllExceptionsFilter },
            { provide: core_2.APP_GUARD, useClass: permissions_guard_1.PermissionsGuard },
            { provide: core_2.APP_INTERCEPTOR, useClass: request_logging_interceptor_1.RequestLoggingInterceptor },
            { provide: core_2.APP_INTERCEPTOR, useClass: response_interceptor_1.ResponseInterceptor },
        ],
    })(TestAppModule);
    const app = await core_1.NestFactory.create(TestAppModule, new platform_fastify_1.FastifyAdapter(), {
        logger: false,
    });
    await (0, bootstrap_1.configureApp)(app, config, mocks.logger);
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    return { app, url, config };
}
