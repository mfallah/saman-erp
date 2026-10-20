import { SetMetadata } from '@nestjs/common';
import { isPermissionKey, type PermissionKey } from '@saman/shared';

/** Permission metadata consumed by the default-deny guard (`ADR-0008`). */
export const PERMISSIONS_KEY = 'saman:permissions';

/**
 * Declares the permission keys a route requires (all of them — AND semantics).
 * An unknown key is a programming error and fails fast at decoration time, which
 * is how default-deny drift is caught before boot (`ADR-0008` §2).
 */
export function Permissions(...permissions: PermissionKey[]): MethodDecorator & ClassDecorator {
  for (const permission of permissions) {
    if (!isPermissionKey(permission)) {
      throw new Error(`Unknown permission key used in @Permissions(): ${permission}`);
    }
  }
  return SetMetadata(PERMISSIONS_KEY, permissions);
}
