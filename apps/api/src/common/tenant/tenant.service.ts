import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import type { TenantContext, TenantAccessor } from '../contracts';

/**
 * AsyncLocalStorage holder for the resolved request tenant/actor.
 *
 * The auth guard (identity module, later) wraps each request in
 * `tenantStorage.run(context, …)`; repositories and audit/outbox writers read it
 * through the `TENANT` token instead of threading context through every call.
 * `TENANT` token and `TenantContext` type are defined in `contracts.ts`.
 */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

@Injectable()
export class TenantService implements TenantAccessor {
  get(): TenantContext {
    const context = tenantStorage.getStore();
    if (context === undefined) {
      throw new Error('tenant_context_missing');
    }
    return context;
  }

  tryGet(): TenantContext | undefined {
    return tenantStorage.getStore();
  }

  run<T>(context: TenantContext, fn: () => T): T {
    return tenantStorage.run(context, fn);
  }
}
