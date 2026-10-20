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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const shared_1 = require("@saman/shared");
const public_decorator_1 = require("../../common/decorators/public.decorator");
/**
 * Anonymous probes outside the `/api/v1` prefix so infra (compose healthcheck,
 * load balancer, uptime monitor) does not depend on the versioned API surface.
 * Responses still use the standard success/error envelope (`API.md` §1.3).
 */
let HealthController = class HealthController {
    health;
    constructor(health) {
        this.health = health;
    }
    live() {
        return this.health.live();
    }
    async ready() {
        const report = await this.health.readiness();
        if (report.status !== 'ok') {
            const failed = Object.entries(report.checks)
                .filter(([, check]) => check.status === 'down')
                .map(([name, check]) => ({
                rule: name,
                params: { reason: check.reason ?? 'unreachable' },
            }));
            throw new shared_1.AppError('SERVICE_DEGRADED', { details: failed, retryAfter: 5 });
        }
        return report;
    }
    version() {
        return this.health.version();
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Get)('live'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], HealthController.prototype, "live", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Get)('ready'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "ready", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Get)('version'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], HealthController.prototype, "version", null);
exports.HealthController = HealthController = __decorate([
    (0, swagger_1.ApiExcludeController)(),
    (0, common_1.Controller)('health'),
    __metadata("design:paramtypes", [Function])
], HealthController);
