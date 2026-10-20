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
exports.DB = exports.DatabaseProvider = void 0;
const common_1 = require("@nestjs/common");
const postgres_1 = __importDefault(require("postgres"));
const env_schema_1 = require("../../config/env.schema");
const contracts_1 = require("../contracts");
Object.defineProperty(exports, "DB", { enumerable: true, get: function () { return contracts_1.DB; } });
/**
 * Single postgres.js pool per process (`ARCHITECTURE.md` §6).
 *
 * Connections are lazy: constructing the provider does not open sockets, so the
 * process boots even when the database is briefly unavailable (readiness reports
 * it, traffic is drained). The pool is closed on graceful shutdown via
 * `app.enableShutdownHooks()`.
 */
let DatabaseProvider = class DatabaseProvider {
    config;
    client;
    constructor(config) {
        this.config = config;
        this.client = (0, postgres_1.default)(config.databaseUrl, {
            max: config.dbPoolMax,
            idle_timeout: Math.max(1, Math.floor(config.dbIdleTimeoutMs / 1000)),
            connect_timeout: 10,
            ...(config.dbSsl ? { ssl: { rejectUnauthorized: true } } : { ssl: false }),
            connection: { application_name: 'saman-erp-api' },
            onnotice: () => undefined,
        });
    }
    async onModuleDestroy() {
        await this.client.end({ timeout: 5 });
    }
};
exports.DatabaseProvider = DatabaseProvider;
exports.DatabaseProvider = DatabaseProvider = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [Object])
], DatabaseProvider);
