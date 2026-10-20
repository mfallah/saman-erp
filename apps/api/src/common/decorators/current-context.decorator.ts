import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError, type PermissionKey } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import type { TenantContext } from '../contracts';
import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { tenantStorage } from '../tenant/tenant.service';

/** Fastify request enriched by the auth guard once identity lands. */
export interface RequestWithContext extends FastifyRequest {
  user?: AuthenticatedActor;
  tenant?: TenantContext;
}

function tenantOf(context: ExecutionContext): TenantContext {
  const request = context.switchToHttp().getRequest<RequestWithContext>();
  const tenant = request.tenant ?? tenantStorage.getStore();
  if (tenant === undefined) {
    throw new AppError('UNAUTHENTICATED', {
      messageKey: 'error.tenant_context_missing',
    });
  }
  return tenant;
}

/**
 * Injects the resolved `TenantContext` (org, actor, scoped branch/warehouse ids,
 * request id). Parameters decorated with `@CurrentUser()` get the actor view.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => tenantOf(context),
);

export interface CurrentActor {
  readonly id: bigint;
  readonly publicId: string;
  readonly orgId: bigint;
  readonly permissions: readonly PermissionKey[];
  readonly branchIds: bigint[] | null;
  readonly warehouseIds: bigint[] | null;
}

/** Injects the authenticated actor (`{ id, publicId, permissions, scope }`). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentActor => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (request.user !== undefined) {
      return {
        id: request.user.id,
        publicId: request.user.publicId,
        orgId: request.user.orgId,
        permissions: request.user.permissions,
        branchIds: request.user.branchIds,
        warehouseIds: request.user.warehouseIds,
      };
    }
    const tenant = tenantOf(context);
    if (tenant.actorId === null || tenant.actorPublicId === null) {
      throw new AppError('UNAUTHENTICATED');
    }
    return {
      id: tenant.actorId,
      publicId: tenant.actorPublicId,
      orgId: tenant.orgId,
      permissions: tenant.permissions,
      branchIds: tenant.branchIds,
      warehouseIds: tenant.warehouseIds,
    };
  },
);
