import { SetMetadata } from '@nestjs/common';

export const SCOPE_METADATA_KEY = 'saman:scope_keys';

/**
 * Enforces the actor's branch/warehouse scope for requests that carry an
 * explicit resource id. Keys are looked up in route params, query and body;
 * scope kind is inferred from the key name (`warehouseId` → warehouse,
 * `branchId` → branch). A `null` actor scope means "unrestricted".
 */
export function ScopeCheck(...keys: string[]): MethodDecorator & ClassDecorator {
  return SetMetadata(SCOPE_METADATA_KEY, keys);
}
