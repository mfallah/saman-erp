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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisProvider = exports.REDIS = void 0;
const common_1 = require("@nestjs/common");
const ioredis_1 = __importDefault(require("ioredis"));
const env_schema_1 = require("../../config/env.schema");
/** DI token for the ioredis client (cache, rate limit, queues, OTP counters). */
exports.REDIS = Symbol.for('saman.redis');
/**
 * Redis is a cache/queue, never a source of truth (`ARCHITECTURE.md` §3):
 * connection is lazy and failures degrade features instead of crashing writes.
 */
let RedisProvider = class RedisProvider {
    client;
    constructor(config) {
        this.client = new ioredis_1.default(config.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5000,
            keyPrefix: config.redisPrefix,
            ...(config.redisPassword !== undefined ? { password: config.redisPassword } : {}),
            ...(config.redisTls ? { tls: { rejectUnauthorized: true } } : {}),
            retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
        });
        // Errors are surfaced by readiness/metrics; an unhandled 'error' event would crash the process.
        this.client.on('error', () => undefined);
    }
    async onModuleDestroy() {
        if (this.client.status !== 'end') {
            try {
                await this.client.quit();
            }
            catch {
                this.client.disconnect();
            }
        }
    }
};
exports.RedisProvider = RedisProvider;
exports.RedisProvider = RedisProvider = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [Object])
], RedisProvider);
