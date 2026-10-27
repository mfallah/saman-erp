import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';

import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { DB, type Db, type TenantContext } from '../contracts';

/** Branch/warehouse scoping shared by `ScopeGuard` and list/detail services (TD-32). */
export type ScopeKind = 'warehouse' | 'branch';

/**
 * Resources a route can address by public id. The guard resolves each one to
 * the warehouse/branch that owns it, so a caller cannot reach a record in
 * another warehouse just because the URL carries only the record id.
 */
export type ScopeResourceKind =
  | 'warehouse'
  | 'branch'
  | 'location'
  | 'sales_order'
  | 'pick_task'
  | 'pack_task'
  | 'pick_wave'
  | 'goods_receipt';

/** Frozen view of the caller's allowed internal ids (`null` = unrestricted). */
export interface ReadScope {
  readonly warehouseIds: ReadonlySet<string> | null;
  readonly branchIds: ReadonlySet<string> | null;
}

export interface ScopeTarget {
  readonly warehouseId: string | null;
  readonly branchId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSet(ids: readonly bigint[] | null): ReadonlySet<string> | null {
  return ids === null ? null : new Set(ids.map((id) => id.toString()));
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Domain 403 (never 404, so the response does not disclose out-of-scope ids). */
export function scopeDenied(scope: ScopeKind | ScopeResourceKind): AppError {
  return new AppError('FORBIDDEN', {
    message: 'دسترسی به این محدوده مجاز نیست.',
    messageKey: 'identity.scope_denied',
    details: [{ rule: 'scope_denied', params: { scope } }],
  });
}

/**
 * Resolves the caller's allowed warehouse/branch ids **once per request** and
 * enforces them. Guards call `forActor`/`resolveTarget`; services call
 * `forContext`/`visibleWarehouseIds` to constrain list queries.
 *
 * The id lists themselves are resolved by the auth guard and carried on the
 * request context; this service caches the normalized sets per request object so
 * repeated checks in one request do no extra work.
 */
@Injectable()
export class ScopeService {
  private readonly cache = new WeakMap<object, ReadScope>();

  constructor(@Inject(DB) private readonly db: Db) {}

  forActor(actor: AuthenticatedActor): ReadScope {
    return this.cached(actor, {
      warehouseIds: toSet(actor.warehouseIds),
      branchIds: toSet(actor.branchIds),
    });
  }

  forContext(ctx: TenantContext): ReadScope {
    return this.cached(ctx, {
      warehouseIds: toSet(ctx.warehouseIds),
      branchIds: toSet(ctx.branchIds),
    });
  }

  /** Effective warehouse ids for list queries: `null` unrestricted, `[]` none. */
  visibleWarehouseIds(scope: ReadScope): readonly string[] | null {
    return scope.warehouseIds === null ? null : [...scope.warehouseIds];
  }

  visibleBranchIds(scope: ReadScope): readonly string[] | null {
    return scope.branchIds === null ? null : [...scope.branchIds];
  }

  allowsWarehouse(scope: ReadScope, id: string | bigint | null | undefined): boolean {
    if (id === null || id === undefined) return true;
    if (scope.warehouseIds === null) return true;
    return scope.warehouseIds.has(id.toString());
  }

  allowsBranch(scope: ReadScope, id: string | bigint | null | undefined): boolean {
    if (id === null || id === undefined) return true;
    if (scope.branchIds === null) return true;
    return scope.branchIds.has(id.toString());
  }

  assertWarehouse(scope: ReadScope, id: string | bigint): void {
    if (!this.allowsWarehouse(scope, id)) throw scopeDenied('warehouse');
  }

  assertBranch(scope: ReadScope, id: string | bigint): void {
    if (!this.allowsBranch(scope, id)) throw scopeDenied('branch');
  }

  assertTarget(scope: ReadScope, target: ScopeTarget, resource: ScopeResourceKind = 'warehouse'): void {
    if (!this.allowsWarehouse(scope, target.warehouseId) || !this.allowsBranch(scope, target.branchId)) {
      throw scopeDenied(resource);
    }
  }

  /** Internal warehouse/branch id for a public id, or `null` when not in the org. */
  async resolvePublicId(kind: ScopeKind, orgId: bigint, publicId: string): Promise<string | null> {
    if (!isUuid(publicId)) return null;
    const table = kind === 'branch' ? 'branches' : 'warehouses';
    const rows = await this.db.unsafe<{ id: string }[]>(
      `select id::text as id from erp.${table} where organization_id = $1 and public_id = $2::uuid limit 1`,
      [orgId.toString(), publicId],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Resolves the warehouse/branch owning a resource. Returns `null` when the
   * public id does not exist in the organization; the guard turns both `null`
   * and an out-of-scope target into the same 403.
   *
   * SQL is selected from a closed union (no caller-controlled identifiers).
   */
  async resolveTarget(
    orgId: bigint,
    resource: ScopeResourceKind,
    publicId: string,
  ): Promise<ScopeTarget | null> {
    if (!isUuid(publicId)) return null;
    const org = orgId.toString();
    const id = publicId;

    let sql: string;
    switch (resource) {
      case 'warehouse':
        sql = `select w.id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.warehouses w
                where w.organization_id = $1 and w.public_id = $2::uuid`;
        break;
      case 'branch':
        sql = `select null::text as warehouse_id, b.id::text as branch_id
                 from erp.branches b
                where b.organization_id = $1 and b.public_id = $2::uuid`;
        break;
      case 'location':
        sql = `select l.warehouse_id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.warehouse_locations l
                 join erp.warehouses w on w.id = l.warehouse_id
                where w.organization_id = $1 and l.public_id = $2::uuid`;
        break;
      case 'sales_order':
        sql = `select o.warehouse_id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.sales_orders o
                 left join erp.warehouses w on w.id = o.warehouse_id
                where o.organization_id = $1 and o.public_id = $2::uuid`;
        break;
      case 'goods_receipt':
        sql = `select gr.warehouse_id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.goods_receipts gr
                 left join erp.warehouses w on w.id = gr.warehouse_id
                where gr.organization_id = $1 and gr.public_id = $2::uuid`;
        break;
      case 'pick_wave':
        sql = `select pw.warehouse_id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.pick_waves pw
                 join erp.warehouses w on w.id = pw.warehouse_id
                where w.organization_id = $1 and pw.public_id = $2::uuid`;
        break;
      case 'pick_task':
        // Location is the strongest warehouse signal; fall back to the order for
        // tasks whose location row was removed (stations must not hide work).
        sql = `select coalesce(l.warehouse_id, o.warehouse_id)::text as warehouse_id,
                      w.branch_id::text as branch_id
                 from erp.pick_tasks t
                 left join erp.warehouse_locations l on l.id = t.location_id
                 left join erp.sales_orders o on o.id = t.order_id
                 left join erp.warehouses w on w.id = coalesce(l.warehouse_id, o.warehouse_id)
                where coalesce(o.organization_id, w.organization_id) = $1 and t.public_id = $2::uuid`;
        break;
      case 'pack_task':
        sql = `select o.warehouse_id::text as warehouse_id, w.branch_id::text as branch_id
                 from erp.pack_tasks pt
                 join erp.sales_orders o on o.id = pt.order_id
                 left join erp.warehouses w on w.id = o.warehouse_id
                where pt.organization_id = $1 and pt.public_id = $2::uuid`;
        break;
    }

    const rows = await this.db.unsafe<{ warehouse_id: string | null; branch_id: string | null }[]>(sql, [
      org,
      id,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return { warehouseId: row.warehouse_id ?? null, branchId: row.branch_id ?? null };
  }

  private cached(key: object, value: ReadScope): ReadScope {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    this.cache.set(key, value);
    return value;
  }
}
