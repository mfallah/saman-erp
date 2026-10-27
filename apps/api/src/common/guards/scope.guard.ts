import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { AppError } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { SCOPE_METADATA_KEY, SCOPE_RESOURCE_KEY } from '../decorators/scope-check.decorator';
import type { ScopeResourceBinding } from '../decorators/scope-check.decorator';
import { isUuid, scopeDenied } from '../scope/scope.service';
import type { ScopeKind } from '../scope/scope.service';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ScopeService } from '../scope/scope.service';

interface RequestLike {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  user?: AuthenticatedActor;
}

/**
 * Row-level scope guard (`SECURITY.md` §5, TD-32): an actor restricted to certain
 * warehouses/branches may only address resources inside that scope.
 *
 * Two ways to declare protection:
 * - `@ScopeCheck('warehouseId')` — explicit id in params/query/body (dotted
 *   paths supported); the public id is resolved to an internal id and compared.
 * - `@ScopeResource('sales_order')` — resource addressed by `:id`; the owning
 *   warehouse/branch is resolved in the database so the URL cannot dodge scope.
 *
 * The allowed id sets are resolved once per request by `ScopeService` and cached
 * for every check in that request. Unrestricted actors (scope `null`) pass.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly scopes: ScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const [keys, resources] = [
      this.reflector.getAllAndOverride<string[] | undefined>(SCOPE_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
      this.reflector.getAllAndOverride<ScopeResourceBinding[] | undefined>(SCOPE_RESOURCE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
    ];
    if ((keys === undefined || keys.length === 0) && (resources === undefined || resources.length === 0)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & RequestLike>();
    const actor = request.user;
    if (actor === undefined) throw new AppError('UNAUTHENTICATED');
    const scope = this.scopes.forActor(actor);

    for (const key of keys ?? []) {
      const kind: ScopeKind = key.toLowerCase().includes('branch') ? 'branch' : 'warehouse';
      const raw = this.pick(key, request);
      if (raw === undefined) continue;

      for (const value of this.valuesOf(raw)) {
        if (value.length === 0) continue;
        const internal = isUuid(value)
          ? await this.scopes.resolvePublicId(kind, actor.orgId, value)
          : value;
        if (internal === null) throw scopeDenied(kind);
        if (kind === 'branch') this.scopes.assertBranch(scope, internal);
        else this.scopes.assertWarehouse(scope, internal);
      }
    }

    for (const binding of resources ?? []) {
      const raw = this.pick(binding.param, request);
      if (raw === undefined) continue;
      for (const value of this.valuesOf(raw)) {
        if (value.length === 0) continue;
        const target = await this.scopes.resolveTarget(actor.orgId, binding.resource, value);
        if (target === null) throw scopeDenied(binding.resource);
        this.scopes.assertTarget(scope, target, binding.resource);
      }
    }
    return true;
  }

  /** Params → query → body, with dotted-path support (`a.b.c`). */
  private pick(key: string, request: RequestLike): unknown {
    const sources: unknown[] = [request.params, request.query, request.body];
    for (const source of sources) {
      const found = this.readPath(source, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private readPath(source: unknown, path: string): unknown {
    if (source === null || typeof source !== 'object') return undefined;
    let current: unknown = source;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  private valuesOf(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map((item) => String(item));
    if (raw === undefined || raw === null) return [];
    return [String(raw)];
  }
}
