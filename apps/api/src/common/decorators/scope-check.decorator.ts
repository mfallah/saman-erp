import { SetMetadata } from '@nestjs/common';
import type { ScopeResourceKind } from '../scope/scope.service';

export const SCOPE_METADATA_KEY = 'saman:scope_keys';
export const SCOPE_RESOURCE_KEY = 'saman:scope_resources';

export interface ScopeResourceBinding {
  readonly resource: ScopeResourceKind;
  /** Route param/query/body key that carries the public id (default `id`). */
  readonly param: string;
}

/**
 * Enforces the actor's branch/warehouse scope for requests that carry an
 * explicit resource id. Keys are looked up in route params, query and body
 * (dotted paths such as `params.filters.warehouseId` are supported); the scope
 * kind is inferred from the key name (`warehouseId` → warehouse,
 * `branchId` → branch). A `null` actor scope means "unrestricted".
 */
export function ScopeCheck(...keys: string[]): MethodDecorator & ClassDecorator {
  return SetMetadata(SCOPE_METADATA_KEY, keys);
}

/**
 * Enforces scope on a resource addressed by public id, resolving the owning
 * warehouse/branch in the database (`sales_order`, `pick_task`, `goods_receipt`,
 * `location`, `pick_wave`, `pack_task`, `warehouse`, `branch`). Missing or
 * out-of-scope ids both return the same 403 domain error.
 */
export function ScopeResource(
  resource: ScopeResourceKind,
  param = 'id',
): MethodDecorator & ClassDecorator {
  return SetMetadata(SCOPE_RESOURCE_KEY, [{ resource, param }] satisfies ScopeResourceBinding[]);
}
