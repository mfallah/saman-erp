"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERMISSIONS_KEY = void 0;
exports.Permissions = Permissions;
const common_1 = require("@nestjs/common");
const shared_1 = require("@saman/shared");
/** Permission metadata consumed by the default-deny guard (`ADR-0008`). */
exports.PERMISSIONS_KEY = 'saman:permissions';
/**
 * Declares the permission keys a route requires (all of them — AND semantics).
 * An unknown key is a programming error and fails fast at decoration time, which
 * is how default-deny drift is caught before boot (`ADR-0008` §2).
 */
function Permissions(...permissions) {
    for (const permission of permissions) {
        if (!(0, shared_1.isPermissionKey)(permission)) {
            throw new Error(`Unknown permission key used in @Permissions(): ${permission}`);
        }
    }
    return (0, common_1.SetMetadata)(exports.PERMISSIONS_KEY, permissions);
}
