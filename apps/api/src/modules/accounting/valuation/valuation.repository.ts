import type { SqlSession } from '../persistence/sql-support';
/** Inventory valuation repository (`erp.inventory_cost_layers`, averages, runs). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { conflict, notFound } from '../persistence/sql-support';
import type { AverageState, CostLayer, VariantValuationRow } from './fifo';

export interface ValuationRunRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly method: string;
  readonly valuationDate: string;
  readonly status: string;
  readonly warehouseId: bigint | null;
  readonly totalQuantity: string;
  readonly totalValueAmount: bigint;
  readonly glInventoryAmount: bigint;
  /** Derived: ledger value − GL value (never stored; the DB CHECK keeps them equal). */
  readonly varianceAmount: bigint;
  readonly journalEntryId: bigint | null;
}

interface RunRow {
  id: string;
  public_id: string;
  valuation_method: string;
  valuation_date: string;
  status: string;
  warehouse_id: string | null;
  total_quantity: string;
  total_value_amount: string;
  gl_inventory_amount: string;
  journal_entry_id: string | null;
}

function toRun(row: RunRow): ValuationRunRecord {
  const totalValue = BigInt(row.total_value_amount);
  const glValue = BigInt(row.gl_inventory_amount);
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    method: row.valuation_method,
    valuationDate: row.valuation_date,
    status: row.status,
    warehouseId: row.warehouse_id === null ? null : BigInt(row.warehouse_id),
    totalQuantity: row.total_quantity,
    totalValueAmount: totalValue,
    glInventoryAmount: glValue,
    varianceAmount: totalValue - glValue,
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
  };
}

const RUN_COLUMNS = `id::text as id, public_id::text as public_id, valuation_method,
  valuation_date::text as valuation_date, status, warehouse_id::text as warehouse_id,
  total_quantity::text as total_quantity, total_value_amount::text as total_value_amount,
  gl_inventory_amount::text as gl_inventory_amount, journal_entry_id::text as journal_entry_id`;

@Injectable()
export class ValuationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Open FIFO layers for a warehouse/variant, ordered by `(received_at, id)`. */
  async openLayers(tx: SqlSession, orgId: bigint, warehouseId: bigint, variantId: bigint): Promise<readonly CostLayer[]> {
    const rows = await tx<{
      id: string;
      received_at: string;
      qty_remaining: string;
      unit_cost_amount: string;
      cost_remaining_amount: string;
    }[]>`
      select id::text as id, received_at::text as received_at, qty_remaining::text as qty_remaining,
             unit_cost_amount::text as unit_cost_amount, cost_remaining_amount::text as cost_remaining_amount
        from erp.inventory_cost_layers
       where organization_id = ${orgId.toString()}
         and warehouse_id = ${warehouseId.toString()}
         and product_variant_id = ${variantId.toString()}
         and qty_remaining > 0
       order by received_at, id`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      receivedAt: row.received_at,
      qtyRemaining: row.qty_remaining,
      unitCostAmount: BigInt(row.unit_cost_amount),
      costRemainingAmount: BigInt(row.cost_remaining_amount),
    }));
  }

  /** Σ remaining layer value and quantity per (warehouse, variant). */
  async layerTotals(
    tx: SqlSession,
    orgId: bigint,
    filter: { readonly warehouseIds?: readonly bigint[]; readonly asOf?: string },
  ): Promise<readonly VariantValuationRow[]> {
    const warehouseIds = filter.warehouseIds === undefined || filter.warehouseIds.length === 0
      ? null
      : filter.warehouseIds.map((id) => id.toString());
    const rows = await tx<{
      warehouse_id: string;
      product_variant_id: string;
      quantity: string;
      value_amount: string;
    }[]>`
      select warehouse_id::text as warehouse_id, product_variant_id::text as product_variant_id,
             coalesce(sum(qty_remaining), 0)::text as quantity,
             coalesce(sum(cost_remaining_amount), 0)::text as value_amount
        from erp.inventory_cost_layers
       where organization_id = ${orgId.toString()}
         and (${warehouseIds === null ? null : warehouseIds}::bigint[] is null or warehouse_id = any(${(warehouseIds ?? []).map((v) => v.toString())}::bigint[]))
         and (${filter.asOf ?? null}::date is null or received_at < ${filter.asOf ?? null}::date + interval '1 day')
       group by warehouse_id, product_variant_id
      having coalesce(sum(qty_remaining), 0) > 0
       order by warehouse_id, product_variant_id`;
    return rows.map((row) => {
      const qtyScaled = parseQtyForUnitCost(row.quantity);
      const valueAmount = BigInt(row.value_amount);
      return {
        warehouseId: BigInt(row.warehouse_id),
        productVariantId: BigInt(row.product_variant_id),
        quantity: row.quantity,
        unitCostAmount: qtyScaled === 0n ? 0n : valueAmount / qtyScaled,
        valueAmount,
      };
    });
  }

  async averageState(tx: SqlSession, warehouseId: bigint, variantId: bigint): Promise<AverageState> {
    const rows = await tx<{ qty_on_hand: string; avg_cost_amount: string; total_value_amount: string }[]>`
      select qty_on_hand::text as qty_on_hand, avg_cost_amount::text as avg_cost_amount,
             total_value_amount::text as total_value_amount
        from erp.inventory_average_costs
       where warehouse_id = ${warehouseId.toString()} and product_variant_id = ${variantId.toString()}`;
    const row = rows[0];
    if (row === undefined) return { qtyOnHand: '0', avgCostAmount: 0n, totalValueAmount: 0n };
    return {
      qtyOnHand: row.qty_on_hand,
      avgCostAmount: BigInt(row.avg_cost_amount),
      totalValueAmount: BigInt(row.total_value_amount),
    };
  }

  async saveAverageState(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly warehouseId: bigint;
      readonly variantId: bigint;
      readonly state: AverageState;
    },
  ): Promise<void> {
    await tx`
      insert into erp.inventory_average_costs
        (organization_id, warehouse_id, product_variant_id, qty_on_hand, avg_cost_amount,
         total_value_amount, last_calculated_at)
      values
        (${input.orgId.toString()}, ${input.warehouseId.toString()}, ${input.variantId.toString()},
         ${input.state.qtyOnHand}, ${input.state.avgCostAmount.toString()},
         ${input.state.totalValueAmount.toString()}, now())
      on conflict (warehouse_id, product_variant_id) do update
        set qty_on_hand = excluded.qty_on_hand,
            avg_cost_amount = excluded.avg_cost_amount,
            total_value_amount = excluded.total_value_amount,
            last_calculated_at = now()`;
  }

  /** GL inventory balance for a period (account `1-1-04-001`). */
  async glInventoryBalance(tx: SqlSession, orgId: bigint, accountCode: string, periodId?: bigint): Promise<bigint> {
    const rows = await tx<{ balance: string }[]>`
      select coalesce(sum(b.closing_debit_amount - b.closing_credit_amount), 0)::text as balance
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and a.code = ${accountCode}
         and (${periodId === undefined ? null : periodId.toString()}::bigint is null or b.period_id = ${periodId === undefined ? null : periodId.toString()}::bigint)`;
    return BigInt(rows[0]?.balance ?? '0');
  }

  /** Creates the run; `gl_inventory_amount` is the reconciliation target. */
  async createRun(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly method: string;
      readonly valuationDate: string;
      readonly warehouseId: bigint | null;
      readonly totalQuantity: string;
      readonly totalValue: bigint;
      readonly glValue: bigint;
      readonly costLayerCount: number;
      readonly status: 'running' | 'completed';
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.inventory_valuation_runs
        (organization_id, warehouse_id, valuation_method, valuation_date, status, cost_layer_count,
         total_quantity, total_value_amount, gl_inventory_amount, completed_at, run_by, created_by)
      values
        (${input.orgId.toString()},
         ${input.warehouseId === null ? null : input.warehouseId.toString()}::bigint,
         ${input.method}, ${input.valuationDate}, ${input.status}, ${input.costLayerCount},
         ${input.totalQuantity}, ${input.totalValue.toString()}, ${input.glValue.toString()},
         case when ${input.status} = 'completed' then now() else null end,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد اجرای ارزش‌گذاری انجام نشد.');
    return BigInt(id);
  }

  async insertRunLines(tx: SqlSession, runId: bigint, rows: readonly VariantValuationRow[]): Promise<void> {
    for (const row of rows) {
      await tx`
        insert into erp.inventory_valuation_lines
          (run_id, product_variant_id, warehouse_id, quantity, unit_cost_amount, total_value_amount, layer_breakdown)
        values
          (${runId.toString()}, ${row.productVariantId.toString()}, ${row.warehouseId.toString()},
           ${row.quantity}, ${row.unitCostAmount.toString()}, ${row.valueAmount.toString()}, '[]'::jsonb)`;
    }
  }

  async findRun(orgId: bigint, id: bigint): Promise<ValuationRunRecord | undefined> {
    const rows = await this.db<RunRow[]>`
      select ${this.db.unsafe(RUN_COLUMNS)}
        from erp.inventory_valuation_runs
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toRun(row);
  }

  async listRuns(
    orgId: bigint,
    filter: { readonly method?: string; readonly status?: string; readonly warehouseId?: bigint },
  ): Promise<readonly ValuationRunRecord[]> {
    const rows = await this.db<RunRow[]>`
      select ${this.db.unsafe(RUN_COLUMNS)}
        from erp.inventory_valuation_runs
       where organization_id = ${orgId.toString()}
         and (${filter.method ?? null}::text is null or valuation_method = ${filter.method ?? null})
         and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
         and (${filter.warehouseId === undefined ? null : filter.warehouseId.toString()}::bigint is null or warehouse_id = ${filter.warehouseId === undefined ? null : filter.warehouseId.toString()}::bigint)
       order by valuation_date desc, id desc`;
    return rows.map(toRun);
  }

  /**
   * Marks the run posted and re-points `gl_inventory_amount` at the adjusted
   * value so the reconciliation CHECK holds after the variance journal.
   */
  async markPosted(tx: SqlSession, id: bigint, journalEntryId: bigint): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.inventory_valuation_runs
         set status = 'posted',
             journal_entry_id = ${journalEntryId.toString()}::bigint,
             gl_inventory_amount = total_value_amount,
             completed_at = coalesce(completed_at, now()),
             version = version + 1
       where id = ${id.toString()} and status <> 'posted'
      returning id::text as id`;
    if (rows.length === 0) throw notFound('اجرای ارزش‌گذاری');
  }

  async runLines(runId: bigint): Promise<readonly VariantValuationRow[]> {
    const rows = await this.db<{
      warehouse_id: string;
      product_variant_id: string;
      quantity: string;
      unit_cost_amount: string;
      total_value_amount: string;
    }[]>`
      select warehouse_id::text as warehouse_id, product_variant_id::text as product_variant_id,
             quantity::text as quantity, unit_cost_amount::text as unit_cost_amount,
             total_value_amount::text as total_value_amount
        from erp.inventory_valuation_lines
       where run_id = ${runId.toString()}
       order by warehouse_id, product_variant_id`;
    return rows.map((row) => ({
      warehouseId: BigInt(row.warehouse_id),
      productVariantId: BigInt(row.product_variant_id),
      quantity: row.quantity,
      unitCostAmount: BigInt(row.unit_cost_amount),
      valueAmount: BigInt(row.total_value_amount),
    }));
  }
}

/** `quantity` text → scaled bigint (10^4) for unit-cost derivation. */
function parseQtyForUnitCost(quantity: string): bigint {
  const [whole = '0', fraction = ''] = quantity.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
}
