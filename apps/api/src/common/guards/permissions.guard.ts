import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
// Reflector is a DI value (constructor metadata), not just a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { AppError, hasPermission, type PermissionKey } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { AUTHENTICATED_ONLY_KEY } from '../decorators/authenticated-only.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

/** Request enriched by the identity guard that lands with the auth module. */
export interface GuardedRequest extends FastifyRequest {
  user?: AuthenticatedActor;
}

/**
 * Default-deny authentication + permission guard (`ADR-0008`).
 *
 * The identity guard runs first and attaches the authenticated actor. Every
 * non-public route then needs (a) an actor and (b) the permission keys declared by
 * `@Permissions(...)`; a non-public route without permission metadata is denied,
 * so new routes fail closed instead of silently shipping open.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets: Array<Type<unknown>> = [
      context.getHandler() as Type<unknown>,
      context.getClass(),
    ];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const actor = request.user;
    if (actor === undefined) {
      throw new AppError('UNAUTHENTICATED', {
        messageKey:
          this.config.appEnv === 'production' ? 'error.unauthenticated' : 'error.auth_not_wired',
      });
    }

    // Self-service authenticated routes (e.g. /auth/me) declare no business
    // permission; IdentityGuard has already proven the session.
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      AUTHENTICATED_ONLY_KEY,
      targets,
    );
    if (authenticatedOnly === true) {
      return true;
    }

    const required =
      this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(
        PERMISSIONS_KEY,
        targets,
      ) ?? [];
    if (required.length === 0) {
      throw new AppError('FORBIDDEN', {
        messageKey: 'error.missing_permission_metadata',
        details: [{ rule: 'missing_permission_metadata' }],
      });
    }
    if (!hasPermission(actor.permissions, required)) {
      throw new AppError('FORBIDDEN', {
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
}
