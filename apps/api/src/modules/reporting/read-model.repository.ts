/**
 * Read-model queries for the reporting module. Every query is closed (seeded code
 * → fixed SQL); no user-supplied SQL reaches the database (`API.md §4.14`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';

export interface ReportRow {
  readonly [key: string]: string | number | null;
}

const SALES_BY_CHANNEL = 'sales-by-channel';
const SALES_BY_PRODUCT = 'sales-by-product';
const SALES_BY_CATEGORY = 'sales-by-category';
const SALES_BY_CUSTOMER = 'sales-by-customer';
const INVENTORY_AGING = 'inventory-aging';
const DEAD_STOCK = 'dead-stock';
const FAST_MOVING = 'fast-moving';
const STOCK_TURNOVER = 'stock-turnover';
const STOCK_MOVEMENT = 'stock-movement';
const STOCK_DISCREPANCY = 'stock-discrepancy';
const SUPPLIER_PERFORMANCE = 'supplier-performance';
const PROCUREMENT_RECOMMENDATIONS = 'procurement-recommendations';
const CHANNEL_PROFIT = 'channel-profit';
const RECEIVABLES_AGING = 'receivables-aging';
const PAYABLES_AGING = 'payables-aging';
const TAX_SUMMARY = 'tax-summary';
const PARTNER_PROFIT = 'partner-profit';
const SETTLEMENT_SUMMARY = 'settlement-summary';
const AUDIT_SUMMARY = 'audit-summary';

/** Seeded report codes this read model can execute (v1). */
export const READ_MODEL_REPORT_CODES: readonly string[] = [
  SALES_BY_CHANNEL,
  SALES_BY_PRODUCT,
  SALES_BY_CATEGORY,
  SALES_BY_CUSTOMER,
  INVENTORY_AGING,
  DEAD_STOCK,
  FAST_MOVING,
  STOCK_TURNOVER,
  STOCK_MOVEMENT,
  STOCK_DISCREPANCY,
  SUPPLIER_PERFORMANCE,
  PROCUREMENT_RECOMMENDATIONS,
  CHANNEL_PROFIT,
  RECEIVABLES_AGING,
  PAYABLES_AGING,
  TAX_SUMMARY,
  PARTNER_PROFIT,
  SETTLEMENT_SUMMARY,
  AUDIT_SUMMARY,
];

export interface ReportRange {
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

@Injectable()
export class ReportingReadModel {
  constructor(@Inject(DB) private readonly db: Db) {}

  supports(code: string): boolean {
    return READ_MODEL_REPORT_CODES.includes(code);
  }

  async run(code: string, orgId: bigint, range: ReportRange): Promise<readonly ReportRow[]> {
    switch (code) {
      case SALES_BY_CHANNEL:
        return this.db<ReportRow[]>`
          select coalesce(ch.code, 'direct') as channel,
                 count(distinct i.id)::bigint::text as invoice_count,
                 coalesce(sum(i.net_amount), 0)::bigint::text as net_amount,
                 coalesce(sum(i.tax_amount), 0)::bigint::text as tax_amount,
                 coalesce(sum(i.grand_total_amount), 0)::bigint::text as gross_amount
            from erp.customer_invoices i
            left join erp.sales_orders o on o.id = i.order_id
            left join erp.channel_accounts ca on ca.id = o.channel_account_id
            left join erp.sales_channels ch on ch.id = ca.channel_id
           where i.organization_id = ${orgId.toString()}
             and i.status in ('issued','partially_paid','paid')
             and i.invoice_date between ${range.from}::date and ${range.to}::date
           group by ch.code
           order by gross_amount desc
           limit ${range.limit}`;
      case SALES_BY_PRODUCT:
        return this.db<ReportRow[]>`
          select pv.sku, p.name_fa as product,
                 coalesce(sum(l.quantity), 0)::text as quantity,
                 coalesce(sum(l.net_amount), 0)::bigint::text as net_amount
            from erp.customer_invoice_lines l
            join erp.customer_invoices i on i.id = l.customer_invoice_id
            join erp.product_variants pv on pv.id = l.product_variant_id
            join erp.products p on p.id = pv.product_id
           where i.organization_id = ${orgId.toString()}
             and i.status in ('issued','partially_paid','paid')
             and i.invoice_date between ${range.from}::date and ${range.to}::date
           group by pv.sku, p.name_fa
           order by net_amount desc
           limit ${range.limit}`;
      case SALES_BY_CATEGORY:
        return this.db<ReportRow[]>`
          select coalesce(c.name_fa, 'بدون دسته') as category,
                 coalesce(sum(l.net_amount), 0)::bigint::text as net_amount
            from erp.customer_invoice_lines l
            join erp.customer_invoices i on i.id = l.customer_invoice_id
            join erp.product_variants pv on pv.id = l.product_variant_id
            join erp.products p on p.id = pv.product_id
            left join erp.product_categories c on c.id = p.category_id
           where i.organization_id = ${orgId.toString()}
             and i.status in ('issued','partially_paid','paid')
             and i.invoice_date between ${range.from}::date and ${range.to}::date
           group by c.name_fa
           order by net_amount desc
           limit ${range.limit}`;
      case SALES_BY_CUSTOMER:
        return this.db<ReportRow[]>`
          select cu.code, cu.name,
                 coalesce(sum(i.grand_total_amount), 0)::bigint::text as gross_amount
            from erp.customer_invoices i
            join erp.customers cu on cu.id = i.customer_id
           where i.organization_id = ${orgId.toString()}
             and i.status in ('issued','partially_paid','paid')
             and i.invoice_date between ${range.from}::date and ${range.to}::date
           group by cu.code, cu.name
           order by gross_amount desc
           limit ${range.limit}`;
      case INVENTORY_AGING:
      case DEAD_STOCK:
      case FAST_MOVING:
      case STOCK_TURNOVER:
        return this.db<ReportRow[]>`
          select pv.sku, p.name_fa as product, w.code as warehouse,
                 coalesce(sum(b.on_hand), 0)::text as on_hand,
                 coalesce(sum(b.on_hand * coalesce(ac.avg_cost_amount, 0)), 0)::bigint::text as inventory_value,
                 max(t.created_at)::text as last_movement_at
            from erp.inventory_balances b
            join erp.product_variants pv on pv.id = b.product_variant_id
            join erp.products p on p.id = pv.product_id
            join erp.warehouses w on w.id = b.warehouse_id
            left join erp.inventory_average_costs ac
                   on ac.warehouse_id = b.warehouse_id and ac.product_variant_id = b.product_variant_id
            left join erp.inventory_transactions t
                   on t.warehouse_id = b.warehouse_id and t.product_variant_id = b.product_variant_id
           where b.organization_id = ${orgId.toString()}
           group by pv.sku, p.name_fa, w.code
          having coalesce(sum(b.on_hand), 0) > 0
           order by inventory_value desc
           limit ${range.limit}`;
      case STOCK_MOVEMENT:
        return this.db<ReportRow[]>`
          select t.transaction_type, coalesce(sum(t.quantity), 0)::text as quantity,
                 coalesce(sum(t.total_cost_amount), 0)::bigint::text as total_cost
            from erp.inventory_transactions t
           where t.organization_id = ${orgId.toString()}
             and t.business_date between ${range.from}::date and ${range.to}::date
           group by t.transaction_type
           order by t.transaction_type`;
      case STOCK_DISCREPANCY:
        return this.db<ReportRow[]>`
          select pv.sku, w.code as warehouse,
                 coalesce(sum(b.on_hand), 0)::text as on_hand,
                 coalesce((select sum(t.quantity) from erp.inventory_transactions t
                            where t.warehouse_id = b.warehouse_id
                              and t.product_variant_id = b.product_variant_id), 0)::text as ledger_quantity
            from erp.inventory_balances b
            join erp.product_variants pv on pv.id = b.product_variant_id
            join erp.warehouses w on w.id = b.warehouse_id
           where b.organization_id = ${orgId.toString()}
           group by pv.sku, w.code, b.warehouse_id, b.product_variant_id
           limit ${range.limit}`;
      case SUPPLIER_PERFORMANCE:
        return this.db<ReportRow[]>`
          select s.code, s.name,
                 count(distinct po.id)::bigint::text as order_count,
                 coalesce(sum(po.total_amount), 0)::bigint::text as ordered_amount
            from erp.purchase_orders po
            join erp.suppliers s on s.id = po.supplier_id
           where po.organization_id = ${orgId.toString()}
             and po.order_date between ${range.from}::date and ${range.to}::date
           group by s.code, s.name
           order by ordered_amount desc
           limit ${range.limit}`;
      case PROCUREMENT_RECOMMENDATIONS:
        return this.db<ReportRow[]>`
          select pv.sku, p.name_fa as product,
                 coalesce(sum(b.on_hand - b.reserved - b.safety_buffer - b.damaged), 0)::text as available,
                 coalesce(rr.reorder_point, 0)::text as reorder_point
            from erp.inventory_balances b
            join erp.product_variants pv on pv.id = b.product_variant_id
            join erp.products p on p.id = pv.product_id
            left join erp.reorder_rules rr on rr.product_variant_id = pv.id
           where b.organization_id = ${orgId.toString()}
           group by pv.sku, p.name_fa, rr.reorder_point
          having coalesce(sum(b.on_hand - b.reserved - b.safety_buffer - b.damaged), 0) <= coalesce(rr.reorder_point, 0)
           order by available
           limit ${range.limit}`;
      case CHANNEL_PROFIT:
        return this.db<ReportRow[]>`
          select coalesce(ch.code, 'direct') as channel,
                 coalesce(sum(cs.gross_sales_amount), 0)::bigint::text as gross,
                 coalesce(sum(cs.commission_amount + cs.fee_amount), 0)::bigint::text as fees,
                 coalesce(sum(cs.net_payable_amount), 0)::bigint::text as net
            from erp.channel_settlements cs
            left join erp.channel_accounts ca on ca.id = cs.channel_account_id
            left join erp.sales_channels ch on ch.id = ca.channel_id
           where cs.organization_id = ${orgId.toString()}
             and cs.period_end_date between ${range.from}::date and ${range.to}::date
           group by ch.code
           order by gross desc
           limit ${range.limit}`;
      case RECEIVABLES_AGING:
      case PAYABLES_AGING: {
        const partyType = code === RECEIVABLES_AGING ? 'customer' : 'supplier';
        return this.db<ReportRow[]>`
          select l.partner_id::text as partner_id,
                 coalesce(sum(l.debit_amount - l.credit_amount), 0)::bigint::text as balance
            from erp.journal_lines l
            join erp.journal_entries e on e.id = l.journal_entry_id
           where e.organization_id = ${orgId.toString()}
             and e.status = 'posted'
             and l.partner_type = ${partyType}
             and e.entry_date <= ${range.to}::date
           group by l.partner_id
          having coalesce(sum(l.debit_amount - l.credit_amount), 0) <> 0
           order by balance desc
           limit ${range.limit}`;
      }
      case TAX_SUMMARY:
        return this.db<ReportRow[]>`
          select td.document_type, coalesce(sum(td.taxable_amount), 0)::bigint::text as taxable,
                 coalesce(sum(td.tax_amount), 0)::bigint::text as tax
            from erp.tax_documents td
           where td.organization_id = ${orgId.toString()}
             and td.status = 'issued'
             and td.issue_date between ${range.from}::date and ${range.to}::date
           group by td.document_type`;
      case PARTNER_PROFIT:
        return this.db<ReportRow[]>`
          select p.code, p.name,
                 coalesce(sum(pl.share_amount), 0)::bigint::text as share_amount,
                 coalesce(sum(pl.paid_amount), 0)::bigint::text as paid_amount
            from erp.profit_distribution_lines pl
            join erp.profit_distribution_runs pr on pr.id = pl.run_id
            join erp.shareholders p on p.id = pl.shareholder_id
           where pr.organization_id = ${orgId.toString()}
           group by p.code, p.name
           order by share_amount desc
           limit ${range.limit}`;
      case SETTLEMENT_SUMMARY:
        return this.db<ReportRow[]>`
          select cs.status, count(*)::bigint::text as settlement_count,
                 coalesce(sum(cs.net_payable_amount), 0)::bigint::text as net_payable
            from erp.channel_settlements cs
           where cs.organization_id = ${orgId.toString()}
             and cs.period_end_date between ${range.from}::date and ${range.to}::date
           group by cs.status`;
      case AUDIT_SUMMARY:
        return this.db<ReportRow[]>`
          select a.action, count(*)::bigint::text as event_count
            from erp.audit_logs a
           where a.organization_id = ${orgId.toString()}
             and a.created_at >= ${range.from}::date
             and a.created_at < ${range.to}::date + interval '1 day'
           group by a.action
           order by event_count desc
           limit ${range.limit}`;
      default:
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'code', rule: 'unsupported_read_model', params: { code } }],
          message: 'این گزارش هنوز مدل خواندنی ندارد.',
        });
    }
  }

  /** Home KPI summary: sales today, open orders, low stock, cash and AR/AP. */
  async dashboardSummary(orgId: bigint, date: string): Promise<Record<string, string>> {
    const rows = await this.db<{
      sales_amount: string; sales_count: string; open_orders: string; low_stock: string;
      receivables: string; payables: string; cash: string;
    }[]>`
      select
        coalesce((select sum(i.grand_total_amount) from erp.customer_invoices i
                   where i.organization_id = ${orgId.toString()} and i.invoice_date = ${date}::date
                     and i.status in ('issued','partially_paid','paid')), 0)::bigint::text as sales_amount,
        coalesce((select count(*) from erp.customer_invoices i
                   where i.organization_id = ${orgId.toString()} and i.invoice_date = ${date}::date
                     and i.status in ('issued','partially_paid','paid')), 0)::bigint::text as sales_count,
        coalesce((select count(*) from erp.sales_orders o
                   where o.organization_id = ${orgId.toString()}
                     and o.status in ('confirmed','allocated','picking','packed')), 0)::bigint::text as open_orders,
        coalesce((select count(*) from erp.inventory_balances b
                   where b.organization_id = ${orgId.toString()}
                     and (b.on_hand - b.reserved - b.safety_buffer - b.damaged) <= 0), 0)::bigint::text as low_stock,
        coalesce((select sum(l.debit_amount - l.credit_amount) from erp.journal_lines l
                   join erp.journal_entries e on e.id = l.journal_entry_id
                   join erp.chart_of_accounts a on a.id = l.account_id
                  where e.organization_id = ${orgId.toString()} and e.status = 'posted'
                    and a.code like '1-1-03-%'), 0)::bigint::text as receivables,
        coalesce((select sum(l.credit_amount - l.debit_amount) from erp.journal_lines l
                   join erp.journal_entries e on e.id = l.journal_entry_id
                   join erp.chart_of_accounts a on a.id = l.account_id
                  where e.organization_id = ${orgId.toString()} and e.status = 'posted'
                    and a.code like '2-1-01-%'), 0)::bigint::text as payables,
        coalesce((select sum(l.debit_amount - l.credit_amount) from erp.journal_lines l
                   join erp.journal_entries e on e.id = l.journal_entry_id
                   join erp.chart_of_accounts a on a.id = l.account_id
                  where e.organization_id = ${orgId.toString()} and e.status = 'posted'
                    and a.code in ('1-1-01-002','1-1-01-003')), 0)::bigint::text as cash`;
    const row = rows[0];
    return {
      salesAmount: row?.sales_amount ?? '0',
      salesCount: row?.sales_count ?? '0',
      openOrders: row?.open_orders ?? '0',
      lowStockCount: row?.low_stock ?? '0',
      receivablesAmount: row?.receivables ?? '0',
      payablesAmount: row?.payables ?? '0',
      cashAmount: row?.cash ?? '0',
    };
  }
}
