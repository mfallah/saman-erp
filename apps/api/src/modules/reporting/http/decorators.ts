/** Local HTTP decorators for the reporting module (same metadata key as foundation). */
import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AppError } from '@saman/shared';
import type { PermissionKey } from '@saman/shared';
import type { TenantContext } from '../../../common/contracts';

export const PERMISSIONS_METADATA_KEY = 'saman:permissions';

export const RequirePermissions = (...permissions: readonly PermissionKey[]): MethodDecorator =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);

interface TenantRequest {
  readonly tenant?: TenantContext;
}

export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<TenantRequest>();
  if (request.tenant === undefined) {
    throw new AppError('UNAUTHENTICATED', { message: 'برای انجام این عملیات باید وارد حساب کاربری شوید.' });
  }
  return request.tenant;
});