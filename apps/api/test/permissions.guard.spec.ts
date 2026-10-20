import { describe, it } from 'node:test';

import { expect, objectContaining } from './support/expect';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@saman/shared';
import { AppError } from '@saman/shared';

import type { AuthenticatedActor } from '../src/common/auth/authenticated-actor';
import { Public } from '../src/common/decorators/public.decorator';
import { Permissions } from '../src/common/decorators/permissions.decorator';
import { PermissionsGuard } from '../src/common/guards/permissions.guard';
import { makeTestConfig } from './support/test-app';

class DemoController {
  @Public()
  anonymousRoute(): void {
    // public endpoint
  }

  @Permissions('inventory.adjust')
  stockRoute(): void {
    // permission-protected endpoint
  }

  undecoratedRoute(): void {
    // missing metadata must fail closed
  }
}

function actorWith(permissions: PermissionKey[]): AuthenticatedActor {
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

function contextFor(handler: (...args: never[]) => void, actor?: AuthenticatedActor): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DemoController,
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, user: actor }),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard (default-deny)', () => {
  const guard = new PermissionsGuard(new Reflector(), makeTestConfig());

  it('allows @Public routes without an actor', () => {
    expect(guard.canActivate(contextFor(DemoController.prototype.anonymousRoute))).toBe(true);
  });

  it('denies non-public routes without an authenticated actor', () => {
    expect(() => guard.canActivate(contextFor(DemoController.prototype.stockRoute))).toThrow();
    try {
      guard.canActivate(contextFor(DemoController.prototype.stockRoute));
    } catch (error) {
      expect((error as AppError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('allows actors holding every declared permission', () => {
    const context = contextFor(DemoController.prototype.stockRoute, actorWith(['inventory.adjust']));
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies actors missing a declared permission', () => {
    const context = contextFor(DemoController.prototype.stockRoute, actorWith(['product.read']));
    try {
      guard.canActivate(context);
      throw new Error('expected guard to throw');
    } catch (error) {
      expect(error instanceof AppError).toBe(true);
      expect((error as AppError).code).toBe('FORBIDDEN');
      expect((error as AppError).details).toEqual([
        objectContaining({ rule: 'missing_permission' }),
      ]);
    }
  });

  it('fails closed when a non-public route declares no permissions', () => {
    const context = contextFor(DemoController.prototype.undecoratedRoute, actorWith([]));
    try {
      guard.canActivate(context);
      throw new Error('expected guard to throw');
    } catch (error) {
      expect((error as AppError).code).toBe('FORBIDDEN');
      expect((error as AppError).messageKey).toBe('error.missing_permission_metadata');
    }
  });

  it('rejects unknown permission keys at decoration time', () => {
    expect(() => Permissions('not.a_real_permission' as PermissionKey)).toThrow(/Unknown permission key/);
  });
});
