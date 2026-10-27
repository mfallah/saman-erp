# Branch / warehouse scope enforcement (TD-32)

## Model

The auth guard resolves the actor's allowed branch/warehouse internal ids into
`TenantContext.branchIds` / `warehouseIds` (`null` = unrestricted, `[]` = none).
`ScopeService` (`apps/api/src/common/scope/scope.service.ts`) normalizes those
ids once per request (WeakMap cache on the request context/actor) and is shared
by the guard and by list services.

Two declarations enforce it:

- `@ScopeCheck('warehouseId' | 'branchId' | dotted.path)` — validates an explicit
  id in route params/query/body. Public UUIDs are resolved to internal ids and
  compared; unknown or out-of-scope ids both produce the same
  `403 FORBIDDEN / identity.scope_denied` domain error.
- `@ScopeResource('sales_order' | 'pick_task' | 'pack_task' | 'pick_wave' |
  'goods_receipt' | 'location' | 'warehouse' | 'branch')` — the route addresses a
  record by `:id`; the guard resolves the owning warehouse and branch in the
  database (`ScopeService.resolveTarget`) and checks both scopes. The resource
  table is chosen from a closed union, never from user input.

List endpoints are constrained in SQL by the same service:
`visibleWarehouseIds(ctx)` returns `null` (no filter), a list (filter), or `[]`
(service returns an empty page before querying).

## Protected routes

| Area | Routes | Mechanism |
|---|---|---|
| Sales orders | `/sales-orders` list/create/update (`warehouseId` in query/body) | `@ScopeCheck('warehouseId')` |
| Sales orders | `/sales-orders/:id` detail, update, delete, submit, confirm, allocate, deallocate, hold, release, cancel, history | `@ScopeResource('sales_order')` |
| Warehouses | `/warehouses/:id` detail, update, delete, tree, capacity, locations, create/bulk locations | `@ScopeResource('warehouse')`; list filtered |
| Warehouse list | `GET /warehouses?branchId=` | `@ScopeCheck('branchId')`; list filtered by allowed warehouses |
| Locations | `/locations/:id` detail, update, delete, move, contents | `@ScopeResource('location')` |
| Location lookup | `GET /locations/lookup?code=` | service check on the resolved location's warehouse |
| Putaway | `GET /putaway/suggestions?warehouseId=` | `@ScopeCheck('warehouseId')` |
| Pick waves | `/pick-waves` list/create and `/:id` detail, release, cancel | `@ScopeResource('pick_wave')` + `@ScopeCheck('warehouseId')`; list filtered |
| Pick tasks | `/pick-tasks` list (filtered) and `/:id` detail, assign, start, scans, complete, short, cancel | `@ScopeResource('pick_task')`; list filtered |
| Pick station | `/warehouse/pick-tasks/mine`, `/board` (filtered); `/:id/start`, `complete`, `assign` | `@ScopeResource('pick_task')`; lists filtered |
| Pack station | `/warehouse/pack-tasks/board` (filtered); `/:id/start`, `complete`, `assign` | `@ScopeResource('pack_task')`; board filtered |
| Purchase receipts | `/purchasing/receipts` list/create (`warehouseId` in query/body) | `@ScopeCheck('warehouseId')`; list filtered |
| Purchase receipts | `/purchasing/receipts/:id`, `/receipts/:id/void` | `@ScopeResource('goods_receipt')` |
| Reports | `POST /reports/:code/run` with `params.filters.warehouseId`/`branchId` | `@ScopeCheck` (nested path) + report policy |
| Dashboard / exports | `GET /dashboard/summary`, `POST /exports` | report policy (see below) |
| Inventory (existing) | `/inventory` routes with `warehouseId` | `@ScopeCheck('warehouseId')` |

## Report policy

- Warehouse-scoped report codes (sales-by-*, inventory-aging/dead-stock/
  fast-moving/stock-turnover/stock-movement/stock-discrepancy/
  procurement-recommendations) run with `warehouseIds` pushed into the read-model
  SQL, so a scoped actor only aggregates their warehouses.
- Reports without a warehouse dimension (supplier performance, channel profit,
  receivables/payables, tax, partner profit, settlement, audit) return
  `403 identity.scope_denied` for a restricted actor instead of leaking
  cross-warehouse totals.
- `GET /dashboard/summary` is organization-wide by construction; restricted actors
  get a 403 and use scoped reports instead.
- `POST /exports` for `inventory`, `inventory-ledger` and `orders` is denied for a
  restricted actor (the export worker has no per-warehouse filter yet).

## Tests

`apps/api/test/scope.guard.spec.ts` covers:

- warehouse-A actor → 403 for a warehouse-B sales order, pick task and goods
  receipt (including unknown ids, which also 403 rather than leaking existence);
- in-scope records and unrestricted actors pass;
- explicit body/query `warehouseId`, including nested
  `params.filters.warehouseId`, is validated;
- empty scope filters lists to an empty orders/pick-task/receipts page.
