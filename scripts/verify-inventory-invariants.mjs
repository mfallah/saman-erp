#!/usr/bin/env node
/**
 * Real-PostgreSQL inventory invariants (idempotent movement + reservation
 * over-allocation), executed against the configured database inside ONE
 * transaction that is always rolled back.
 *
 * Usage (production DB credentials are never stored here):
 *   DATABASE_URL='postgres://…' \
 *     apps/api/node_modules/.bin/tsx --tsconfig apps/api/tsconfig.json \
 *     scripts/verify-inventory-invariants.mjs
 *
 * If the workspace esbuild binary is stale, also set ESBUILD_BINARY_PATH to the
 * matching `@esbuild/win32-x64/esbuild.exe` (see apps/api/vitest.config.ts note).
 *
 * The script exits non-zero if any check fails. It creates no permanent rows.
 */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { asDb } from '../apps/api/src/modules/inventory/inventory.pg-support.ts';
import { InventoryRepository } from '../apps/api/src/modules/inventory/inventory.repository.ts';
import { InventoryService } from '../apps/api/src/modules/inventory/inventory.service.ts';

const databaseUrl = process.env.DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error('DATABASE_URL (or MIGRATION_DATABASE_URL) is required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${String(detail).slice(0, 160)}`}`);
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15, onnotice: () => undefined });
const ROLLBACK = new Error('inventory_verify_rollback');

try {
  const fixtures = await sql`
    select o.id::text as "orgId", o.timezone,
           w.public_id::text as "warehouseId", l.public_id::text as "locationId",
           v.public_id::text as "variantId", v.id::text as "variantInternalId",
           b.id::text as "balanceId",
           p.start_date::text as "businessDate"
    from erp.organizations o
    join erp.fiscal_years fy on fy.organization_id = o.id
    join erp.accounting_periods p on p.fiscal_year_id = fy.id
    join erp.warehouses w on w.organization_id = o.id and w.deleted_at is null
    join erp.warehouse_locations l on l.warehouse_id = w.id and l.is_active
    join erp.product_variants v on true
    join erp.products pr on pr.id = v.product_id and pr.organization_id = o.id
    join erp.inventory_balances b
      on b.organization_id = o.id and b.warehouse_id = w.id
     and b.location_id = l.id and b.product_variant_id = v.id
    where p.start_date <= current_date and p.end_date >= current_date
      and p.status = 'open' and b.on_hand > 0
    order by b.id
    limit 1
  `;
  if (fixtures.length === 0) {
    throw new Error('no open period + positive inventory balance fixture found');
  }
  const fixture = fixtures[0];
  const ctx = {
    requestId: `verify-${randomUUID()}`,
    orgId: BigInt(fixture.orgId),
    orgPublicId: '00000000-0000-0000-0000-000000000001',
    actorId: null,
    actorPublicId: null,
    permissions: [],
    branchIds: null,
    warehouseIds: null,
  };
  const businessDate = String(fixture.businessDate).slice(0, 10);
  const variantId = fixture.variantId;
  const warehouseId = fixture.warehouseId;
  const locationId = fixture.locationId;
  const balanceId = BigInt(fixture.balanceId);
  const idempotencyKey = `verify:${randomUUID()}`;
  const before = {
    ledger: (await sql`select count(*)::int n from erp.inventory_transactions`)[0].n,
    requests: (await sql`select count(*)::int n from erp.idempotency_keys where scope = 'inventory.post_movement'`)[0].n,
    reservations: (await sql`select count(*)::int n from erp.stock_reservations`)[0].n,
    balance: (
      await sql`select on_hand::text as "onHand", reserved::text as "reserved" from erp.inventory_balances where id = ${balanceId}`
    )[0],
  };

  try {
    await sql.begin(async (tx) => {
      const db = asDb(tx);
      const repo = new InventoryRepository(db);
      const catalog = {
        requireVariant: async () => ({
          id: variantId,
          internalId: BigInt(fixture.variantInternalId),
          costMethod: 'moving_average',
        }),
        findVariants: async () => [
          {
            id: variantId,
            internalId: BigInt(fixture.variantInternalId),
            costMethod: 'moving_average',
          },
        ],
      };
      const service = new InventoryService(
        db,
        repo,
        catalog,
        { record: async () => undefined },
        { emit: async () => undefined },
      );
      const input = {
        warehouseId,
        locationId,
        variantId,
        type: 'adjustment_in',
        quantity: '1',
        unitCostAmount: 1n,
        referenceType: 'manual',
        idempotencyKey,
        businessDate,
      };

      const ledgerBefore = (await tx`select count(*)::int n from erp.inventory_transactions`)[0].n;
      const first = await service.postMovement(db, ctx, input);
      const ledgerAfterFirst = (await tx`select count(*)::int n from erp.inventory_transactions`)[0].n;
      check(
        'fresh post writes exactly one ledger row',
        ledgerAfterFirst === ledgerBefore + 1,
        `${ledgerBefore} → ${ledgerAfterFirst}`,
      );

      const replay = await service.postMovement(db, ctx, input);
      const ledgerAfterReplay = (await tx`select count(*)::int n from erp.inventory_transactions`)[0].n;
      check('retry returns the same transaction id', replay.transaction.id === first.transaction.id, replay.transaction.id);
      check('retry does not write a second ledger row', ledgerAfterReplay === ledgerAfterFirst, `${ledgerAfterReplay}`);

      let conflictCode = null;
      try {
        await service.postMovement(db, ctx, { ...input, quantity: '2' });
      } catch (error) {
        conflictCode = error?.code ?? null;
      }
      check('same key + different payload returns CONFLICT', conflictCode === 'CONFLICT', conflictCode);

      const reservationsBefore = (await tx`select count(*)::int n from erp.stock_reservations`)[0].n;
      const balance = (
        await tx`
          select id::text as id, (on_hand - reserved - safety_buffer - damaged)::text as available
          from erp.inventory_balances where id = ${balanceId}
        `
      )[0];
      const reservation = await service.reserveForReference(db, ctx, {
        referenceType: 'manual',
        referenceInternalId: 0n,
        referencePublicId: null,
        lines: [{ variantId, quantity: balance.available }],
        ttlMinutes: 30,
        reason: 'verify-inventory-invariants',
      });
      const reservedNo = reservation.reservations[0]?.reservationNo;
      check(
        'reservation number is collision-free and within 40 chars',
        typeof reservedNo === 'string' && /^RSV-[0-9A-F]{32}$/.test(reservedNo) && reservedNo.length <= 40,
        reservedNo,
      );

      let oversellCode = null;
      try {
        await service.reserveForReference(db, ctx, {
          referenceType: 'manual',
          referenceInternalId: 0n,
          referencePublicId: null,
          lines: [{ variantId, quantity: '0.0001' }],
          ttlMinutes: 30,
          reason: 'verify-oversell',
        });
      } catch (error) {
        oversellCode = error?.code ?? null;
      }
      const reservedAfter = (
        await tx`
          select on_hand::text as "onHand", reserved::text as "reserved",
                 (reserved <= on_hand) as "withinOnHand"
          from erp.inventory_balances where id = ${balanceId}
        `
      )[0];
      const reservationsAfter = (await tx`select count(*)::int n from erp.stock_reservations`)[0].n;
      check('second reservation for the last unit is rejected', oversellCode === 'INSUFFICIENT_STOCK', oversellCode);
      check(
        'reserved never exceeds on-hand',
        reservedAfter.withinOnHand === true,
        `on_hand=${reservedAfter.onHand}, reserved=${reservedAfter.reserved}`,
      );
      check(
        'rejected reservation writes no reservation row',
        reservationsAfter === reservationsBefore + 1,
        `${reservationsBefore} → ${reservationsAfter}`,
      );

      // Always roll back, even when every check passed.
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) {
      check('verification transaction executes', false, error?.message ?? String(error));
    }
  }

  const after = {
    ledger: (await sql`select count(*)::int n from erp.inventory_transactions`)[0].n,
    requests: (await sql`select count(*)::int n from erp.idempotency_keys where scope = 'inventory.post_movement'`)[0].n,
    reservations: (await sql`select count(*)::int n from erp.stock_reservations`)[0].n,
    balance: (
      await sql`select on_hand::text as "onHand", reserved::text as "reserved" from erp.inventory_balances where id = ${balanceId}`
    )[0],
  };
  check('ledger rolled back', after.ledger === before.ledger, `${before.ledger} → ${after.ledger}`);
  check('idempotency hash sidecar rolled back', after.requests === before.requests, `${before.requests} → ${after.requests}`);
  check('reservations rolled back', after.reservations === before.reservations, `${before.reservations} → ${after.reservations}`);
  check(
    'balance projection rolled back',
    after.balance.onHand === before.balance.onHand && after.balance.reserved === before.balance.reserved,
    `${before.balance.onHand}/${before.balance.reserved} → ${after.balance.onHand}/${after.balance.reserved}`,
  );
} finally {
  await sql.end({ timeout: 5 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
