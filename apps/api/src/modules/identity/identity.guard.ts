import { Inject, Injectable, type CanActivate, type ExecutionContext, type Type } from '@nestjs/common';
// Reflector is a DI value (constructor metadata), not just a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { AppError, type PermissionKey } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import type { TenantContext } from '../../common/contracts';
import type { AuthenticatedActor } from '../../common/auth/authenticated-actor';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { tenantStorage } from '../../common/tenant/tenant.service';
import { AuthRepository } from './auth.repository';
import { TokenService, ttlToSeconds } from './token.service';

export interface GuardedIdentityRequest extends FastifyRequest {
  user?: AuthenticatedActor;
  tenant?: TenantContext;
}

/**
 * Authentication guard for the default-deny pipeline (`ADR-0004`, `ADR-0008`).
 * Verifies the access JWT, loads the current user/session/permissions (so a
 * permission-version bump or session revocation takes effect immediately),
 * and publishes the tenant context. Permission-key enforcement stays in
 * `PermissionsGuard` as the second, fail-closed layer.
 */
@Injectable()
export class IdentityGuard implements CanActivate {
  private readonly tokens: TokenService;

  constructor(
    private readonly reflector: Reflector,
    private readonly repository: AuthRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.tokens = new TokenService({
      secret: config.jwtAccessSecret,
      accessTtlSeconds: ttlToSeconds(config.jwtAccessTtl),
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets: Array<Type<unknown>> = [
      context.getHandler() as Type<unknown>,
      context.getClass(),
    ];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<GuardedIdentityRequest>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED');
    }
    const claims = this.tokens.verifyAccessToken(authorization.slice(7).trim());
    const [user, session] = await Promise.all([
      this.repository.findUserByPublicId(claims.sub),
      this.repository.findSessionByPublicId(claims.sid),
    ]);
    if (user === null || session === null || session.revokedAt !== null) {
      throw new AppError('UNAUTHENTICATED', { messageKey: 'error.session_revoked' });
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new AppError('SESSION_REVOKED', { messageKey: 'error.session_revoked' });
    }
    if (user.status === 'inactive') {
      throw new AppError('UNAUTHENTICATED');
    }
    if (claims.pv !== user.permissionsVersion) {
      throw new AppError('PERMISSIONS_CHANGED');
    }

    const access = await this.repository.loadAccess(user.id);
    const permissions = access.permissionKeys.filter((key): key is PermissionKey => key.includes('.'));
    const actor: AuthenticatedActor = {
      id: user.id,
      publicId: user.publicId,
      orgId: user.organizationId,
      orgPublicId: claims.org,
      permissions,
      branchIds: access.branchIds,
      warehouseIds: access.warehouseIds,
      sessionId: session.id,
      sessionPublicId: session.publicId,
      permissionsVersion: user.permissionsVersion,
    };
    const userAgent = request.headers['user-agent'];
    const tenant: TenantContext = {
      requestId: String(request.headers['x-request-id'] ?? ''),
      orgId: user.organizationId,
      orgPublicId: claims.org,
      actorId: user.id,
      actorPublicId: user.publicId,
      permissions,
      branchIds: access.branchIds,
      warehouseIds: access.warehouseIds,
      sessionPublicId: session.publicId,
      ...(typeof request.ip === 'string' ? { ip: request.ip } : {}),
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    };
    request.user = actor;
    request.tenant = tenant;
    tenantStorage.enterWith(tenant);
    return true;
  }
}
