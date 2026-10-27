/**
 * TD-32 — branch/warehouse scope enforcement (guard + list filtering).
 *
 * A user scoped to warehouse A must get a 403 for warehouse-B records on every
 * scoped surface (orders, pick tasks, receipts) even though those URLs carry only
 * the record id, and list endpoints must return nothing outside scope.
 */
import { describe, it } from 'node:test';

import { expect } from './support/expect';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AppError } from '@saman/shared';

import type { AuthenticatedActor } from '../src/common/auth/authenticated-actor';
import type { TenantContext } from '../src/common/contracts';
import { ScopeCheck, ScopeResource } from '../src/common/decorators/scope-check.decorator';
import { ScopeGuard } from '../src/common/guards/scope.guard';
import { ScopeService } from '../src/common/scope/scope.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { PurchasingService } from '../src/modules/purchasing/purchasing.service';

const ID = {
  warehouseA: '11111111-1111-4111-8111-111111111111',
  warehouseB: '22222222-2222-4222-8222-222222222222',
  orderA: '33333333-3333-4333-8333-333333333333',
  orderB: '44444444-4444-4444-8444-444444444444',
  pickA: '55555555-5555-4555-8555-555555555555',
  pickB: '66666666-6666-4666-8666-666666666666',
  receiptA: '77777777-7777-4777-8777-777777777777',
  receiptB: '88888888-8888-4888-8888-888888888888',
};

/** Every resource id maps to warehouse A (…111) or B (…222). */
const TARGETS: Record<string, { warehouse_id: string; branch_id: string | null }> = {
  [ID.warehouseA]: { warehouse_id: '1', branch_id: null },
  [ID.warehouseB]: { warehouse_id: '2', branch_id: null },
  [ID.orderA]: { warehouse_id: '1', branch_id: null },
  [ID.orderB]: { warehouse_id: '2', branch_id: null },
  [ID.pickA]: { warehouse_id: '1', branch_id: null },
  [ID.pickB]: { warehouse_id: '2', branch_id: null },
  [ID.receiptA]: { warehouse_id: '1', branch_id: null },
  [ID.receiptB]: { warehouse_id: '2', branch_id: null },
};

function fakeDb() {
  const calls: string[] = [];
  const db = {
    unsafe: async (query: string, params?: readonly unknown[]) => {
      calls.push(query);
      const publicId = String(params?.[1] ?? '');
      const target = TARGETS[publicId];
      if (target === undefined) return [];
      // `resolvePublicId` selects just the owning id; `resolveTarget` the pair.
      if (/select id::text as id from erp\.(warehouses|branches)/.test(query)) {
        return [{ id: target.warehouse_id }];
      }
      return [target];
    },
  };
  return { db, calls };
}

function actorWith(warehouseIds: bigint[] | null, branchIds: bigint[] | null = null): AuthenticatedActor {
  return {
    id: 7n,
    publicId: '0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
    orgId: 1n,
    orgPublicId: '2f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
    permissions: [],
    sessionId: 1n,
    sessionPublicId: '1f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11',
    permissionsVersion: 1,
    branchIds,
    warehouseIds,
  };
}

function ctxWith(warehouseIds: bigint[] | null, branchIds: bigint[] | null = null): TenantContext {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    orgId: 1n,
    orgPublicId: '22222222-2222-4222-8222-222222222222',
    actorId: 7n,
    actorPublicId: '33333333-3333-4333-8333-333333333333',
    permissions: [],
    branchIds,
    warehouseIds,
  };
}

class OrderRoutes {
  @ScopeResource('sales_order')
  detail(): void {}
}

class PickRoutes {
  @ScopeResource('pick_task')
  detail(): void {}
}

class ReceiptRoutes {
  @ScopeResource('goods_receipt')
  detail(): void {}
}

class FilterRoutes {
  @ScopeCheck('warehouseId')
  create(): void {}

  @ScopeCheck('params.filters.warehouseId')
  runReport(): void {}
}

function contextFor(
  handler: () => void,
  routeClass: unknown,
  actor: AuthenticatedActor,
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => routeClass,
    switchToHttp: () => ({
      getRequest: () => ({ params: {}, query: {}, body: {}, ...request, user: actor }),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

async function catchesAsync(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a scope denial');
}

function makeGuard() {
  const { db, calls } = fakeDb();
  const scopes = new ScopeService(db as never);
  return { guard: new ScopeGuard(new Reflector(), scopes), calls };
}

describe('ScopeGuard (TD-32)', () => {
  it('403s a warehouse-A user on a warehouse-B sales order detail', async () => {
    const { guard } = makeGuard();
    const context = contextFor(OrderRoutes.prototype.detail, OrderRoutes, actorWith([1n]), {
      params: { id: ID.orderB },
    });
    const error = await catchesAsync(() => guard.canActivate(context));
    expect(error instanceof AppError).toBe(true);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.messageKey).toBe('identity.scope_denied');
    expect(error.details).toEqual([{ rule: 'scope_denied', params: { scope: 'sales_order' } }]);
  });

  it('403s on warehouse-B pick tasks and goods receipts', async () => {
    const { guard } = makeGuard();
    const pick = contextFor(PickRoutes.prototype.detail, PickRoutes, actorWith([1n]), { params: { id: ID.pickB } });
    expect((await catchesAsync(() => guard.canActivate(pick))).code).toBe('FORBIDDEN');

    const receipt = contextFor(ReceiptRoutes.prototype.detail, ReceiptRoutes, actorWith([1n]), {
      params: { id: ID.receiptB },
    });
    expect((await catchesAsync(() => guard.canActivate(receipt))).code).toBe('FORBIDDEN');
  });

  it('allows in-scope records and unrestricted actors', async () => {
    const { guard } = makeGuard();
    const inScope = contextFor(OrderRoutes.prototype.detail, OrderRoutes, actorWith([1n]), {
      params: { id: ID.orderA },
    });
    expect(await guard.canActivate(inScope)).toBe(true);

    const unrestricted = contextFor(OrderRoutes.prototype.detail, OrderRoutes, actorWith(null), {
      params: { id: ID.orderB },
    });
    expect(await guard.canActivate(unrestricted)).toBe(true);
  });

  it('treats an empty scope as no access and an unknown id as a 403 (no existence oracle)', async () => {
    const { guard } = makeGuard();
    const none = contextFor(PickRoutes.prototype.detail, PickRoutes, actorWith([]), { params: { id: ID.pickA } });
    expect((await catchesAsync(() => guard.canActivate(none))).code).toBe('FORBIDDEN');

    const unknown = contextFor(ReceiptRoutes.prototype.detail, ReceiptRoutes, actorWith([1n]), {
      params: { id: '99999999-9999-4999-8999-999999999999' },
    });
    expect((await catchesAsync(() => guard.canActivate(unknown))).code).toBe('FORBIDDEN');
  });

  it('validates explicit warehouseId in body/query, including nested report filters', async () => {
    const { guard } = makeGuard();
    const body = contextFor(FilterRoutes.prototype.create, FilterRoutes, actorWith([1n]), {
      body: { warehouseId: ID.warehouseB },
    });
    expect((await catchesAsync(() => guard.canActivate(body))).code).toBe('FORBIDDEN');

    const dotted = contextFor(FilterRoutes.prototype.runReport, FilterRoutes, actorWith([1n]), {
      body: { params: { filters: { warehouseId: ID.warehouseB } } },
    });
    expect((await catchesAsync(() => guard.canActivate(dotted))).code).toBe('FORBIDDEN');

    const allowed = contextFor(FilterRoutes.prototype.create, FilterRoutes, actorWith([1n]), {
      body: { warehouseId: ID.warehouseA },
    });
    expect(await guard.canActivate(allowed)).toBe(true);
  });
});

describe('scoped list filtering', () => {
  it('visibleWarehouseIds is null for unrestricted, ids for scoped, empty for none', () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);
    expect(scopes.visibleWarehouseIds(scopes.forContext(ctxWith(null)))).toBeNull();
    expect(scopes.visibleWarehouseIds(scopes.forContext(ctxWith([1n])))).toEqual(['1']);
    expect(scopes.visibleWarehouseIds(scopes.forContext(ctxWith([])))).toEqual([]);
  });

  it('passes only warehouse A to the orders query, so B rows cannot be listed', async () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);
    const seen: unknown[] = [];
    const repo = {
      listOrders: async (_db: unknown, params: unknown) => {
        seen.push(params);
        return [];
      },
    };
    const service = new SalesService(
      {} as never,
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      scopes,
    );
    expect(await service.listOrders(ctxWith([1n]), { limit: 20 })).toEqual([]);
    expect((seen[0] as { warehouseIds: string[] }).warehouseIds).toEqual(['1']);
  });

  it('passes only warehouse A to the pick-task and receipt queries', async () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);

    const pickSeen: unknown[] = [];
    const pickRepo = {
      listPickTasks: async (_db: unknown, params: unknown) => {
        pickSeen.push(params);
        return [];
      },
    };
    const warehouse = new WarehouseService(
      {} as never, pickRepo as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, scopes,
    );
    await warehouse.listPickTasks(ctxWith([1n]), { limit: 20 });
    expect((pickSeen[0] as { warehouseIds: string[] }).warehouseIds).toEqual(['1']);

    const receiptSeen: unknown[] = [];
    const receiptRepo = {
      listReceipts: async (_db: unknown, params: unknown) => {
        receiptSeen.push(params);
        return [];
      },
      countReceipts: async () => 0,
    };
    const purchasing = new PurchasingService(
      {} as never, receiptRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never, scopes,
    );
    await purchasing.listReceipts(ctxWith([1n]), { page: 1, perPage: 20 });
    expect((receiptSeen[0] as { warehouseIds: string[] }).warehouseIds).toEqual(['1']);
  });

  it('returns an empty orders page for a caller allowed no warehouse (repo never queried)', async () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);
    const service = new SalesService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      scopes,
    );
    expect(await service.listOrders(ctxWith([]), { limit: 20 })).toEqual([]);
  });

  it('returns an empty pick-task page for a caller allowed no warehouse', async () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);
    const service = new WarehouseService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, scopes,
    );
    expect(await service.listPickTasks(ctxWith([]), { limit: 20 })).toEqual([]);
  });

  it('returns an empty receipts page for a caller allowed no warehouse', async () => {
    const { db } = fakeDb();
    const scopes = new ScopeService(db as never);
    const service = new PurchasingService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, scopes,
    );
    const result = await service.listReceipts(ctxWith([]), { page: 1, perPage: 20 });
    expect(result).toEqual({ items: [], total: 0 });
  });
});
