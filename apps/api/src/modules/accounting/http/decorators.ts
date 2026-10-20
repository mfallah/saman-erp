/**
 * Local HTTP decorators for the finance modules.
 *
 * The platform foundation (`apps/api/src/common/decorators/*`) is owned by the
 * backend-core agent and does not exist yet. These decorators use the same
 * metadata key the global guard is expected to read (`saman:permissions`) and the
 * same tenant attachment (`request.tenant`), so swapping to the foundation
 * decorators later is a one-line import change per controller.
 */
import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@saman/shared';
import { AppError } from '@saman/shared';
import type { TenantContext } from '../../../common/contracts';

export const PERMISSIONS_METADATA_KEY = 'saman:permissions';

/** Declares the exact permission keys required by a route (no prefix matching). */
export const RequirePermissions = (...permissions: readonly PermissionKey[]): MethodDecorator =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);

interface TenantRequest {
  readonly tenant?: TenantContext;
}

/** Injects the authenticated tenant context; absence is a 401, never a default. */
export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<TenantRequest>();
  if (request.tenant === undefined) {
    throw new AppError('UNAUTHENTICATED', { message: 'برای انجام این عملیات باید وارد حساب کاربری شوید.' });
  }
  return request.tenant;
});
