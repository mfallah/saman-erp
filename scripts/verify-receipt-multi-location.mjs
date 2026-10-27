#!/usr/bin/env node
/**
 * Real-PostgreSQL proof that ONE goods receipt can place its lines in different
 * warehouses/locations, executed against the configured database inside ONE
 * transaction that is always rolled back.
 *
 * Usage (production DB credentials are never stored here):
 *   DATABASE_URL='postgres://…' \
 *     apps/api/node_modules/.bin/tsx --tsconfig apps/api/tsconfig.json \
 *     scripts/verify-receipt-multi-location.mjs
 *
 * What it checks:
 *   1. line 1 (no placement) lands in the receipt-level warehouse/location,
 *   2. line 2 (`warehouseId` + `locationId`) lands in the second location,
 *   3. ledger rows and balances reflect BOTH locations for the same receipt,
 *   4. the receipt header keeps the receipt-level warehouse,
 *   5. a location from another warehouse is rejected with
 *      `location_warehouse_mismatch` and writes nothing.
 *
 * The script exits non-zero if any check fails. It creates no permanent rows.
 */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { asDb } from '../apps/api/src/modules/inventory/inventory.pg-support.ts';
import { InventoryRepository } from '../apps/api/src/modules/inventory/inventory.repository.ts';
import { InventoryService } from '../apps/api/src/modules/inventory/inventory.service.ts';
import { PurchasingRepository } from '../apps/api/src/modules/purchasing/purchasing.repository.ts';
import { PurchasingService } from '../apps/api/src/modules/purchasing/purchasing.service.ts';

const databaseUrl = process.env.DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error('DATABASE_URL (or MIGRATION_DATABASE_URL) is required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${String(detail).slice(0, 200)}`}`);
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15, onnotice: () => undefined });
const ROLLBACK = new Error('receipt_multi_location_verify_rollback');

try {
  const fixtures = await sql`
    select o.id::text as "orgId", o.timezone, current_date::text as "businessDate",
           w.public_id::text as "warehouseId", w.id::text as "warehouseInternalId", w.name as "warehouseName"
    from erp.organizations o
    join erp.fiscal_years fy on fy.organization_id = o.id
    join erp.accounting_periods p on p.fiscal_year_id = fy.id
    join erp.warehouses w on w.organization_id = o.id and w.deleted_at is null
    where p.start_date <= current_date and p.end_date >= current_date
      and p.status = 'open'
      and (select count(*) from erp.warehouse_locations l where l.warehouse_id = w.id and l.is_active) >= 2
    order by w.id
    limit 1
  `;
  if (fixtures.length === 0) {
    throw new Error('no open period + warehouse with two active locations fixture found');
  }
  const fixture = fixtures[0];
  const orgId = BigInt(fixture.orgId);
  const warehouseId = fixture.warehouseId;
  const businessDate = String(fixture.businessDate).slice(0, 10);

  const locations = await sql`
    select l.public_id::text as "locationId", l.id::text as "locationInternalId", l.full_code as "fullCode"
    from erp.warehouse_locations l
    join erp.warehouses w on w.id = l.warehouse_id
    where w.organization_id = ${orgId} and l.warehouse_id = ${BigInt(fixture.warehouseInternalId)}
      and l.is_active and w.deleted_at is null
    order by l.pick_priority asc, l.full_code asc
    limit 2
  `;
  if (locations.length < 2) throw new Error('warehouse lost its second active location');
  const headerLocation = locations[0];
  const otherLocation = locations[1];

  const variants = await sql`
    select v.public_id::text as "variantId", v.id::text as "variantInternalId"
    from erp.product_variants v
    join erp.products pr on pr.id = v.product_id
    where pr.organization_id = ${orgId}
    order by v.id
    limit 1
  `;
  if (variants.length === 0) throw new Error('no variant fixture found');
  const variant = variants[0];

  const ctx = {    requestId: `verify-${randomUUID()}`,
    orgId,
    orgPublicId: '00000000-0000-0000-0000-000000000001',
    actorId: null,
    actorPublicId: null,
    permissions: [],
    branchIds: null,
    warehouseIds: null,
  };

  const countsBefore = (
    await sql`
      select (select count(*)::int from erp.goods_receipts) as "receipts",
             (select count(*)::int from erp.suppliers where organization_id = ${orgId}) as "suppliers"
    `
  )[0];

  try {
    await sql.begin(async (tx) => {
      const db = asDb(tx);
      // The service opens its own `db.begin`. `postgres.js` transaction handles do
      // not expose `.begin`, so emulate a nested transaction with a savepoint; the
      // outer (always-rolled-back) transaction still owns the final state.
      let savepoint = 0;
      db.begin = async (callback) => {
        savepoint += 1;
        const name = `verify_receipt_sp_${savepoint}`;
        await tx.unsafe(`savepoint ${name}`);
        try {
          const result = await callback(db);
          await tx.unsafe(`release savepoint ${name}`);
          return result;
        } catch (error) {
          await tx.unsafe(`rollback to savepoint ${name}`);
          throw error;
        }
      };
      const inventoryRepo = new InventoryRepository(db);
      const catalog = {
        requireVariant: async () => ({
          id: variant.variantId,
          internalId: BigInt(variant.variantInternalId),
          costMethod: 'moving_average',
          sku: 'VERIFY-SKU',
          productName: 'کالای آزمایشی',
        }),
        findVariants: async () => [
          {
            id: variant.variantId,
            internalId: BigInt(variant.variantInternalId),
            costMethod: 'moving_average',
          },
        ],
        latestCost: async () => '1000',
        labelData: async () => [
          {
            variantId: variant.variantId,
            sku: 'VERIFY-SKU',
            productName: 'کالای آزمایشی',
            barcode: '2900000000001',
          },
        ],
      };
      const audit = { record: async () => undefined };
      const events = { emit: async () => undefined };
      const inventory = new InventoryService(db, inventoryRepo, catalog, audit, events);
      const purchasingRepo = new PurchasingRepository(db);
      const service = new PurchasingService(
        db,
        purchasingRepo,
        inventory,
        catalog,
        { trigger: async () => { throw new Error('no channel in verify'); }, runJob: async () => undefined },
        audit,
        { get: () => { throw new Error('no module ref in verify'); } },
        { visibleWarehouseIds: () => null, forContext: () => ({}) },
      );

      const before = await tx`
        select l.public_id::text as "locationId", coalesce(b.on_hand, 0)::text as "onHand"
        from erp.warehouse_locations l
        left join erp.inventory_balances b
          on b.location_id = l.id and b.product_variant_id = ${BigInt(variant.variantInternalId)}
        where l.id in (${BigInt(headerLocation.locationInternalId)}, ${BigInt(otherLocation.locationInternalId)})
      `;
      const beforeByLocation = new Map(before.map((row) => [row.locationId, Number(row.onHand || '0')]));

      const receipt = await service.createReceipt(ctx, {
        supplierName: 'تست رسید چندموقعیتی',
        warehouseId,
        receivedAt: `${businessDate}T10:00:00+03:30`,
        lines: [
          // No per-line placement: must fall back to the receipt-level location.
          { variantId: variant.variantId, quantity: '2', unitCost: '1000' },
          // Explicit per-line placement: must land in the OTHER location.
          {
            variantId: variant.variantId,
            quantity: '3',
            unitCost: '1000',
            warehouseId,
            locationId: otherLocation.locationId,
          },
        ],
      });
      const receiptPublicId = String(receipt['id'] ?? '');

      const ledger = await tx`
        select l.public_id::text as "locationId", w.public_id::text as "warehouseId",
               sum(t.quantity)::text as quantity, count(*)::int as "rowCount"
        from erp.inventory_transactions t
        join erp.warehouse_locations l on l.id = t.location_id
        join erp.warehouses w on w.id = t.warehouse_id
        where t.organization_id = ${orgId}
          and t.reference_type = 'goods_receipt'
          and t.reference_public_id = ${receiptPublicId}
        group by l.public_id, w.public_id
        order by l.public_id
      `;
      const ledgerByLocation = new Map(ledger.map((row) => [row.locationId, row]));
      check('receipt posts exactly one ledger row per line', ledger.reduce((sum, row) => sum + row.rowCount, 0) === 2, JSON.stringify(ledger));
      check(
        'line without placement lands in the receipt-level location',
        Number(ledgerByLocation.get(headerLocation.locationId)?.quantity ?? 'NaN') === 2,
        JSON.stringify(ledger),
      );
      check(
        'line with warehouseId/locationId lands in the chosen location',
        Number(ledgerByLocation.get(otherLocation.locationId)?.quantity ?? 'NaN') === 3,
        JSON.stringify(ledger),
      );
      check('the two lines land in two DISTINCT locations', ledgerByLocation.size === 2, `${ledgerByLocation.size} location(s)`);

      const balances = await tx`
        select l.public_id::text as "locationId", b.on_hand::text as "onHand"
        from erp.inventory_balances b
        join erp.warehouse_locations l on l.id = b.location_id
        where b.organization_id = ${orgId}
          and b.product_variant_id = ${BigInt(variant.variantInternalId)}
          and b.location_id in (${BigInt(headerLocation.locationInternalId)}, ${BigInt(otherLocation.locationInternalId)})
      `;
      const balanceByLocation = new Map(balances.map((row) => [row.locationId, Number(row.onHand)]));
      check(
        'balance projection increases in the header location by 2',
        (balanceByLocation.get(headerLocation.locationId) ?? 0) - (beforeByLocation.get(headerLocation.locationId) ?? 0) === 2,
        `${beforeByLocation.get(headerLocation.locationId) ?? 0} → ${balanceByLocation.get(headerLocation.locationId) ?? 0}`,
      );
      check(
        'balance projection increases in the chosen location by 3',
        (balanceByLocation.get(otherLocation.locationId) ?? 0) - (beforeByLocation.get(otherLocation.locationId) ?? 0) === 3,
        `${beforeByLocation.get(otherLocation.locationId) ?? 0} → ${balanceByLocation.get(otherLocation.locationId) ?? 0}`,
      );

      const header = await tx`
        select w.public_id::text as "warehouseId",
               (select count(*)::int from erp.goods_receipt_lines gl where gl.receipt_id = gr.id) as "lineCount"
        from erp.goods_receipts gr
        join erp.warehouses w on w.id = gr.warehouse_id
        where gr.public_id = ${receiptPublicId}
      `;
      check('receipt header keeps the receipt-level warehouse', header[0]?.warehouseId === warehouseId, JSON.stringify(header));
      check('receipt stores both lines', header[0]?.lineCount === 2, `lineCount=${header[0]?.lineCount}`);

      // The unsaved-receipt label preview must render the same SVG sheet.
      const previewSvg = await service.previewReceiptLabelsSvg(ctx, {
        warehouseId,
        lines: [
          { variantId: variant.variantId, quantity: '1', serials: ['VERIFY-SN-1'] },
          { variantId: variant.variantId, quantity: '2' },
        ],
      });
      check(
        'label preview returns the receipt SVG sheet before saving',
        previewSvg.startsWith('<?xml') && previewSvg.includes('<svg') && previewSvg.includes('SN: VERIFY-SN-1'),
        `${previewSvg.length} bytes`,
      );

      // Negative check: a location of a different warehouse must be rejected.
      const foreignWarehouse = await tx`
        insert into erp.warehouses (organization_id, code, name, warehouse_type, is_active)
        values (${orgId}, ${`VRF-${randomUUID().slice(0, 8)}`}, 'انبار تست اعتبارسنجی', 'main', true)
        returning id::text as id
      `;
      const foreignLocation = await tx`
        insert into erp.warehouse_locations (warehouse_id, full_code, location_type, is_pickable, is_active)
        values (${BigInt(foreignWarehouse[0].id)}, 'VRF-01', 'storage', true, true)
        returning public_id::text as "locationId"
      `;
      const receiptsBefore = (await tx`select count(*)::int as n from erp.goods_receipts`)[0].n;
      let mismatchRule = null;
      let mismatchCode = null;
      try {
        await service.createReceipt(ctx, {
          supplierName: 'تست رد موقعیت ناهمخوان',
          warehouseId,
          receivedAt: `${businessDate}T10:00:00+03:30`,
          lines: [
            {
              variantId: variant.variantId,
              quantity: '1',
              unitCost: '1000',
              warehouseId,
              locationId: foreignLocation[0].locationId,
            },
          ],
        });
      } catch (error) {
        mismatchCode = error?.code ?? null;
        mismatchRule = error?.details?.[0]?.rule ?? null;
      }
      const receiptsAfter = (await tx`select count(*)::int as n from erp.goods_receipts`)[0].n;
      check(
        'location from another warehouse is rejected as location_warehouse_mismatch',
        mismatchCode === 'VALIDATION_ERROR' && mismatchRule === 'location_warehouse_mismatch',
        `${mismatchCode}/${mismatchRule}`,
      );
      check('rejected placement writes no receipt row', receiptsBefore === receiptsAfter, `${receiptsBefore} → ${receiptsAfter}`);

      // Always roll back, even when every check passed.
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) {
      check('verification transaction executes', false, error?.message ?? String(error));
    }
  }

  const countsAfter = (
    await sql`
      select (select count(*)::int from erp.goods_receipts) as "receipts",
             (select count(*)::int from erp.suppliers where organization_id = ${orgId}) as "suppliers"
    `
  )[0];
  check(
    'nothing was committed (receipts + suppliers unchanged after rollback)',
    countsAfter.receipts === countsBefore.receipts && countsAfter.suppliers === countsBefore.suppliers,
    `receipts ${countsBefore.receipts} → ${countsAfter.receipts}, suppliers ${countsBefore.suppliers} → ${countsAfter.suppliers}`,
  );
} finally {
  await sql.end({ timeout: 5 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
