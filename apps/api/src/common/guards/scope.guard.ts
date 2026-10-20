import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { DB, type Db } from '../contracts';
import { SCOPE_METADATA_KEY } from '../decorators/scope-check.decorator';

type ScopeKind = 'warehouse' | 'branch';
interface RequestLike {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  user?: AuthenticatedActor;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Row-level scope guard (`SECURITY.md` §5): an actor restricted to certain
 * warehouses/branches may only address resources inside that scope.
 * Unrestricted actors (scope `null`) pass through.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const keys = this.reflector.getAllAndOverride<string[] | undefined>(SCOPE_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (keys === undefined || keys.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & RequestLike>();
    const actor = request.user;
    if (actor === undefined) throw new AppError('UNAUTHENTICATED');

    for (const key of keys) {
      const kind: ScopeKind = key.toLowerCase().startsWith('branch') ? 'branch' : 'warehouse';
      const allowed = kind === 'branch' ? actor.branchIds : actor.warehouseIds;
      if (allowed === null) continue;

      const raw = this.pick(key, request);
      if (raw === undefined) continue;
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];

      for (const value of values) {
        if (value.length === 0) continue;
        const internal = UUID.test(value) ? await this.resolve(kind, value, actor.orgId) : value;
        if (internal === null) {
          throw new AppError('FORBIDDEN', {
            message: 'دسترسی به این محدوده مجاز نیست.',
            messageKey: 'identity.scope_denied',
            details: [{ rule: 'scope_denied', params: { scope: kind } }],
          });
        }
        if (!allowed.map((id) => id.toString()).includes(internal)) {
          throw new AppError('FORBIDDEN', {
            message: 'دسترسی به این محدوده مجاز نیست.',
            messageKey: 'identity.scope_denied',
            details: [{ rule: 'scope_denied', params: { scope: kind } }],
          });
        }
      }
    }
    return true;
  }

  private pick(key: string, request: RequestLike): unknown {
    const fromParams = request.params?.[key];
    if (fromParams !== undefined) return fromParams;
    const fromQuery = request.query?.[key];
    if (fromQuery !== undefined) return fromQuery;
    const body = request.body;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return (body as Record<string, unknown>)[key];
    }
    return undefined;
  }

  private async resolve(kind: ScopeKind, publicId: string, orgId: bigint): Promise<string | null> {
    // Table name is chosen from a fixed union (no user input).
    const table = kind === 'branch' ? 'branches' : 'warehouses';
    const rows = await this.db.unsafe<{ id: string }[]>(
      `select id::text as id from erp.${table} where organization_id = $1 and public_id = $2::uuid limit 1`,
      [orgId.toString(), publicId],
    );
    return rows[0]?.id ?? null;
  }
}
