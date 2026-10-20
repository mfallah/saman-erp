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
exports.HealthService = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const common_1 = require("@nestjs/common");
const env_schema_1 = require("../../config/env.schema");
const contracts_1 = require("../../common/contracts");
const redis_provider_1 = require("../../common/providers/redis.provider");
const READINESS_TIMEOUT_MS = 1500;
const PACKAGE_MANIFEST_PATH = (0, node_path_1.join)(__dirname, '..', '..', '..', 'package.json');
function readManifest() {
    try {
        const raw = (0, node_fs_1.readFileSync)(PACKAGE_MANIFEST_PATH, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
async function withTimeout(operation, milliseconds) {
    let timer;
    try {
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('dependency_timeout')), milliseconds);
            timer.unref();
        });
        return await Promise.race([operation, timeout]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Liveness/readiness/version probes (`API.md` §4.19, `ARCHITECTURE.md` §12).
 * Dependencies are pinged with a hard timeout so a hung dependency turns into a
 * fast `503` for the load balancer instead of piling up requests.
 */
let HealthService = class HealthService {
    db;
    redis;
    config;
    manifest = readManifest();
    constructor(db, redis, config) {
        this.db = db;
        this.redis = redis;
        this.config = config;
    }
    live() {
        return {
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        };
    }
    version() {
        return {
            name: this.manifest.name ?? 'saman-api',
            version: this.manifest.version ?? '0.0.0',
            schemaVersion: process.env['SCHEMA_VERSION'] ?? 'unmanaged',
            env: this.config.appEnv,
            commit: this.config.gitSha,
        };
    }
    async readiness() {
        const [db, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
        // S3 readiness is wired with the files module; it is reported explicitly as
        // skipped instead of pretending the dependency is healthy.
        const s3 = { status: 'skipped', reason: 'files_module_pending' };
        const required = [db, redis];
        return {
            status: required.every((check) => check.status === 'up') ? 'ok' : 'degraded',
            checks: { db, redis, s3 },
            timestamp: new Date().toISOString(),
        };
    }
    async checkDatabase() {
        const startedAt = process.hrtime.bigint();
        try {
            await withTimeout(this.db `select 1 as ok`, READINESS_TIMEOUT_MS);
            return { status: 'up', latencyMs: elapsedMs(startedAt) };
        }
        catch {
            return { status: 'down', latencyMs: elapsedMs(startedAt), reason: 'database_unreachable' };
        }
    }
    async checkRedis() {
        const startedAt = process.hrtime.bigint();
        try {
            await withTimeout(this.redis.ping(), READINESS_TIMEOUT_MS);
            return { status: 'up', latencyMs: elapsedMs(startedAt) };
        }
        catch {
            return { status: 'down', latencyMs: elapsedMs(startedAt), reason: 'redis_unreachable' };
        }
    }
};
exports.HealthService = HealthService;
exports.HealthService = HealthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(contracts_1.DB)),
    __param(1, (0, common_1.Inject)(redis_provider_1.REDIS)),
    __param(2, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [Function, Function, Object])
], HealthService);
function elapsedMs(startedAt) {
    return Math.round(Number(process.hrtime.bigint() - startedAt) / 100_000) / 10;
}
