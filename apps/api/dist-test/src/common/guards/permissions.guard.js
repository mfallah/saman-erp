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
exports.PermissionsGuard = void 0;
const common_1 = require("@nestjs/common");
// Reflector is a DI value (constructor metadata), not just a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const core_1 = require("@nestjs/core");
const shared_1 = require("@saman/shared");
const env_schema_1 = require("../../config/env.schema");
const public_decorator_1 = require("../decorators/public.decorator");
const permissions_decorator_1 = require("../decorators/permissions.decorator");
/**
 * Default-deny authentication + permission guard (`ADR-0008`).
 *
 * The identity guard runs first and attaches the authenticated actor. Every
 * non-public route then needs (a) an actor and (b) the permission keys declared by
 * `@Permissions(...)`; a non-public route without permission metadata is denied,
 * so new routes fail closed instead of silently shipping open.
 */
let PermissionsGuard = class PermissionsGuard {
    reflector;
    config;
    constructor(reflector, config) {
        this.reflector = reflector;
        this.config = config;
    }
    canActivate(context) {
        const targets = [
            context.getHandler(),
            context.getClass(),
        ];
        const isPublic = this.reflector.getAllAndOverride(public_decorator_1.IS_PUBLIC_KEY, targets);
        if (isPublic === true) {
            return true;
        }
        const request = context.switchToHttp().getRequest();
        const actor = request.user;
        if (actor === undefined) {
            throw new shared_1.AppError('UNAUTHENTICATED', {
                messageKey: this.config.appEnv === 'production' ? 'error.unauthenticated' : 'error.auth_not_wired',
            });
        }
        const required = this.reflector.getAllAndOverride(permissions_decorator_1.PERMISSIONS_KEY, targets) ?? [];
        if (required.length === 0) {
            throw new shared_1.AppError('FORBIDDEN', {
                messageKey: 'error.missing_permission_metadata',
                details: [{ rule: 'missing_permission_metadata' }],
            });
        }
        if (!(0, shared_1.hasPermission)(actor.permissions, required)) {
            throw new shared_1.AppError('FORBIDDEN', {
                details: required
                    .filter((permission) => !actor.permissions.includes(permission))
                    .map((permission) => ({
                    rule: 'missing_permission',
                    params: { permission },
                })),
            });
        }
        return true;
    }
};
exports.PermissionsGuard = PermissionsGuard;
exports.PermissionsGuard = PermissionsGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)(env_schema_1.APP_CONFIG)),
    __metadata("design:paramtypes", [core_1.Reflector, Object])
], PermissionsGuard);
