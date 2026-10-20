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
const node_test_1 = require("node:test");
const expect_1 = require("./support/expect");
const core_1 = require("@nestjs/core");
const shared_1 = require("@saman/shared");
const public_decorator_1 = require("../src/common/decorators/public.decorator");
const permissions_decorator_1 = require("../src/common/decorators/permissions.decorator");
const permissions_guard_1 = require("../src/common/guards/permissions.guard");
const test_app_1 = require("./support/test-app");
class DemoController {
    anonymousRoute() {
        // public endpoint
    }
    stockRoute() {
        // permission-protected endpoint
    }
    undecoratedRoute() {
        // missing metadata must fail closed
    }
}
__decorate([
    (0, public_decorator_1.Public)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DemoController.prototype, "anonymousRoute", null);
__decorate([
    (0, permissions_decorator_1.Permissions)('inventory.adjust'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DemoController.prototype, "stockRoute", null);
function actorWith(permissions) {
    return {
        id: 1n,
        publicId: '0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
        orgId: 1n,
        permissions,
        orgPublicId: '2f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
        sessionId: 1n,
        sessionPublicId: '1f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
        permissionsVersion: 1,
        branchIds: null,
        warehouseIds: null,
    };
}
function contextFor(handler, actor) {
    return {
        getHandler: () => handler,
        getClass: () => DemoController,
        switchToHttp: () => ({
            getRequest: () => ({ headers: {}, user: actor }),
            getResponse: () => ({}),
            getNext: () => undefined,
        }),
    };
}
(0, node_test_1.describe)('PermissionsGuard (default-deny)', () => {
    const guard = new permissions_guard_1.PermissionsGuard(new core_1.Reflector(), (0, test_app_1.makeTestConfig)());
    (0, node_test_1.it)('allows @Public routes without an actor', () => {
        (0, expect_1.expect)(guard.canActivate(contextFor(DemoController.prototype.anonymousRoute))).toBe(true);
    });
    (0, node_test_1.it)('denies non-public routes without an authenticated actor', () => {
        (0, expect_1.expect)(() => guard.canActivate(contextFor(DemoController.prototype.stockRoute))).toThrow();
        try {
            guard.canActivate(contextFor(DemoController.prototype.stockRoute));
        }
        catch (error) {
            (0, expect_1.expect)(error.code).toBe('UNAUTHENTICATED');
        }
    });
    (0, node_test_1.it)('allows actors holding every declared permission', () => {
        const context = contextFor(DemoController.prototype.stockRoute, actorWith(['inventory.adjust']));
        (0, expect_1.expect)(guard.canActivate(context)).toBe(true);
    });
    (0, node_test_1.it)('denies actors missing a declared permission', () => {
        const context = contextFor(DemoController.prototype.stockRoute, actorWith(['product.read']));
        try {
            guard.canActivate(context);
            throw new Error('expected guard to throw');
        }
        catch (error) {
            (0, expect_1.expect)(error instanceof shared_1.AppError).toBe(true);
            (0, expect_1.expect)(error.code).toBe('FORBIDDEN');
            (0, expect_1.expect)(error.details).toEqual([
                (0, expect_1.objectContaining)({ rule: 'missing_permission' }),
            ]);
        }
    });
    (0, node_test_1.it)('fails closed when a non-public route declares no permissions', () => {
        const context = contextFor(DemoController.prototype.undecoratedRoute, actorWith([]));
        try {
            guard.canActivate(context);
            throw new Error('expected guard to throw');
        }
        catch (error) {
            (0, expect_1.expect)(error.code).toBe('FORBIDDEN');
            (0, expect_1.expect)(error.messageKey).toBe('error.missing_permission_metadata');
        }
    });
    (0, node_test_1.it)('rejects unknown permission keys at decoration time', () => {
        (0, expect_1.expect)(() => (0, permissions_decorator_1.Permissions)('not.a_real_permission')).toThrow(/Unknown permission key/);
    });
});
