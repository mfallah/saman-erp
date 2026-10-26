/**
 * Read-model queries for the reporting module. Every query is closed (seeded code
 * → fixed SQL); no user-supplied SQL reaches the database (`API.md §4.14`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, isoToJalali, jalaliMonthRange } from '@saman/shared';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';

export interface ReportRow {
  readonly [key: string]: string | number | null;
}

/** Per-account channel sync state shown on the home dashboard. */
export interface DashboardChannelStatus {
  readonly accountId: string;
  readonly name: string;
  readonly channelCode: string;
  readonly lastSyncAt: string | null;
  readonly lastSyncStatus: string | null;
  readonly stockPushEnabled: boolean;
}

/** Digikala integration state (never exposes the token itself). */
export interface DashboardDigikalaStatus {
  readonly connected: boolean;
  readonly accessTokenPresent: boolean;
  readonly lastOrderPullAt: string | null;
  readonly lastPushAt: string | null;
  readonly lastError: string | null;
}

export interface DashboardKpis {
  /* legacy flat fields (kept for existing consumers) */
  readonly salesAmount: string;
  readonly salesCount: string;
  readonly openOrders: string;
  readonly lowStockCount: string;
  readonly receivablesAmount: string;
  readonly payablesAmount: string;
  readonly cashAmount: string;
  /* real-data groups */
  readonly products: { readonly total: number; readonly active: number; readonly outOfStock: number };
  readonly inventory: { readonly onHandTotal: string; readonly skuCount: number };
  readonly orders: { readonly open: number; readonly today: number };
  readonly sales: { readonly todayAmount: string; readonly monthAmount: string };
  readonly channels: readonly DashboardChannelStatus[];
  readonly digikala: DashboardDigikalaStatus;
  readonly salesSeries: readonly { readonly date: string; readonly amount: string }[];
  readonly lowStock: readonly {
    readonly id: string;
    readonly onHand: string;
    readonly available: string;
    readonly product: { readonly id: string; readonly name: string };
    readonly variant: { readonly id: string; readonly code: string };
  }[];
  readonly recentOrders: readonly {
    readonly id: string;
    readonly orderNumber: string | null;
    readonly status: string;
    readonly total: string;
    readonly orderDate: string;
    readonly customer: { readonly id: string; readonly name: string } | null;
  }[];
}

interface DashboardKpiRow {
  sales_amount: string;
  sales_count: string;
  open_orders: string;
  low_stock: string;
  receivables: string;
  payables: string;
  cash: string;
  products_total: string;
  products_active: string;
  products_out_of_stock: string;
  inventory_on_hand: string;
  inventory_sku_count: string;
  orders_today: string;
  sales_month_amount: string;
}

interface DashboardSeriesRow {
  date: string;
  amount: string;
}

interface DashboardLowStockRow {
  id: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_code: string;
  on_hand: string;
  available: string;
}

interface DashboardRecentOrderRow {
  id: string;
  order_no: string | null;
  status: string;
  total: string;
  order_date: string;
  customer_id: string | null;
  customer_name: string | null;
}

interface DashboardChannelRow {
  account_id: string;
  name: string;
  channel_code: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  stock_push_enabled: boolean;
}

interface DashboardDigikalaRow {
  connected: boolean;
  access_token_present: boolean;
  last_order_pull_at: string | null;
  last_push_at: string | null;
  last_error: string | null;
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

  /**
   * Home KPI summary. Every value comes from org-scoped SQL; the Jalali month
   * bound is resolved in code so `sales.monthAmount` follows the Iranian calendar.
   */
  async dashboardSummary(orgId: bigint, date: string): Promise<DashboardKpis> {
    const org = orgId.toString();
    const jalali = isoToJalali(date);
    const month = jalaliMonthRange(jalali.jy, jalali.jm);

    const [kpiRows, seriesRows, lowStockRows, recentOrderRows, channelRows, digikalaRows] = await Promise.all([
      this.db<DashboardKpiRow[]>`
        select
          coalesce((select sum(i.grand_total_amount) from erp.customer_invoices i
                     where i.organization_id = ${org} and i.invoice_date = ${date}::date
                       and i.status in ('issued','partially_paid','paid')), 0)::bigint::text as sales_amount,
          coalesce((select count(*) from erp.customer_invoices i
                     where i.organization_id = ${org} and i.invoice_date = ${date}::date
                       and i.status in ('issued','partially_paid','paid')), 0)::bigint::text as sales_count,
          coalesce((select count(*) from erp.sales_orders o
                     where o.organization_id = ${org}
                       and o.status in ('confirmed','allocated','picking','packed')), 0)::bigint::text as open_orders,
          coalesce((select count(*) from erp.inventory_balances b
                     where b.organization_id = ${org}
                       and (b.on_hand - b.reserved - b.safety_buffer - b.damaged) <= 0), 0)::bigint::text as low_stock,
          coalesce((select sum(l.debit_amount - l.credit_amount) from erp.journal_lines l
                     join erp.journal_entries e on e.id = l.journal_entry_id
                     join erp.chart_of_accounts a on a.id = l.account_id
                    where e.organization_id = ${org} and e.status = 'posted'
                      and a.code like '1-1-03-%'), 0)::bigint::text as receivables,
          coalesce((select sum(l.credit_amount - l.debit_amount) from erp.journal_lines l
                     join erp.journal_entries e on e.id = l.journal_entry_id
                     join erp.chart_of_accounts a on a.id = l.account_id
                    where e.organization_id = ${org} and e.status = 'posted'
                      and a.code like '2-1-01-%'), 0)::bigint::text as payables,
          coalesce((select sum(l.debit_amount - l.credit_amount) from erp.journal_lines l
                     join erp.journal_entries e on e.id = l.journal_entry_id
                     join erp.chart_of_accounts a on a.id = l.account_id
                    where e.organization_id = ${org} and e.status = 'posted'
                      and a.code in ('1-1-01-002','1-1-01-003')), 0)::bigint::text as cash,
          coalesce((select count(*) from erp.products p
                     where p.organization_id = ${org} and p.deleted_at is null), 0)::bigint::text as products_total,
          coalesce((select count(*) from erp.products p
                     where p.organization_id = ${org} and p.deleted_at is null
                       and p.status = 'active'), 0)::bigint::text as products_active,
          coalesce((select count(*) from erp.products p
                     where p.organization_id = ${org} and p.deleted_at is null
                       and coalesce((select sum(b.on_hand - b.reserved - b.safety_buffer - b.damaged)
                                       from erp.inventory_balances b
                                       join erp.product_variants pv on pv.id = b.product_variant_id
                                      where pv.product_id = p.id and b.organization_id = ${org}), 0) <= 0),
                   0)::bigint::text as products_out_of_stock,
          coalesce((select sum(b.on_hand) from erp.inventory_balances b
                     where b.organization_id = ${org}), 0)::numeric(18,4)::text as inventory_on_hand,
          coalesce((select count(distinct b.product_variant_id) from erp.inventory_balances b
                     where b.organization_id = ${org} and b.on_hand > 0), 0)::bigint::text as inventory_sku_count,
          coalesce((select count(*) from erp.sales_orders o
                     where o.organization_id = ${org} and o.business_date = ${date}::date), 0)::bigint::text as orders_today,
          coalesce((select sum(i.grand_total_amount) from erp.customer_invoices i
                     where i.organization_id = ${org}
                       and i.status in ('issued','partially_paid','paid')
                       and i.invoice_date between ${month.start}::date and ${date}::date), 0)::bigint::text as sales_month_amount`,
      this.db<DashboardSeriesRow[]>`
        select d.day::date::text as date,
               coalesce((select sum(i.grand_total_amount) from erp.customer_invoices i
                          where i.organization_id = ${org} and i.invoice_date = d.day::date
                            and i.status in ('issued','partially_paid','paid')), 0)::bigint::text as amount
          from generate_series(${date}::date - interval '13 days', ${date}::date, interval '1 day') as d(day)
         order by d.day`,
      this.db<DashboardLowStockRow[]>`
        select pv.public_id::text as id,
               p.public_id::text as product_id,
               p.name as product_name,
               pv.public_id::text as variant_id,
               pv.sku as variant_code,
               coalesce(sum(b.on_hand), 0)::numeric(18,4)::text as on_hand,
               coalesce(sum(b.on_hand - b.reserved - b.safety_buffer - b.damaged), 0)::numeric(18,4)::text as available
          from erp.inventory_balances b
          join erp.product_variants pv on pv.id = b.product_variant_id
          join erp.products p on p.id = pv.product_id
         where b.organization_id = ${org}
         group by pv.public_id, p.public_id, p.name, pv.sku
        having coalesce(sum(b.on_hand - b.reserved - b.safety_buffer - b.damaged), 0) <= 0
         order by available asc
         limit 6`,
      this.db<DashboardRecentOrderRow[]>`
        select o.public_id::text as id,
               o.order_no,
               o.status,
               o.grand_total_amount::text as total,
               o.business_date::text as order_date,
               c.public_id::text as customer_id,
               coalesce(c.full_name, c.customer_no) as customer_name
          from erp.sales_orders o
          left join erp.customers c on c.id = o.customer_id
         where o.organization_id = ${org}
         order by o.created_at desc
         limit 5`,
      this.db<DashboardChannelRow[]>`
        select ca.public_id::text as account_id,
               ca.name,
               ch.code as channel_code,
               coalesce(sj.at, hc.checked_at)::text as last_sync_at,
               coalesce(sj.status, case when hc.consecutive_failures > 0 then 'failed' else 'ok' end) as last_sync_status,
               ca.stock_push_enabled
          from erp.channel_accounts ca
          join erp.sales_channels ch on ch.id = ca.channel_id
          left join lateral (
                select j.status, coalesce(j.finished_at, j.started_at, j.created_at) as at
                  from erp.channel_sync_jobs j
                 where j.channel_account_id = ca.id
                 order by j.created_at desc
                 limit 1
               ) sj on true
          left join lateral (
                select h.checked_at, h.consecutive_failures
                  from erp.channel_health_checks h
                 where h.channel_account_id = ca.id
                 order by h.checked_at desc
                 limit 1
               ) hc on true
         where ca.organization_id = ${org}
           and ca.deleted_at is null
         order by ch.code, ca.name`,
      this.db<DashboardDigikalaRow[]>`
        select
          exists (select 1 from erp.channel_accounts ca
                    join erp.sales_channels ch on ch.id = ca.channel_id
                   where ca.organization_id = ${org}
                     and ca.deleted_at is null
                     and ch.code = 'digikala') as connected,
          exists (select 1 from erp.channel_credentials cr
                    join erp.channel_accounts ca on ca.id = cr.channel_account_id
                    join erp.sales_channels ch on ch.id = ca.channel_id
                   where ca.organization_id = ${org}
                     and ca.deleted_at is null
                     and ch.code = 'digikala'
                     and cr.is_active
                     and cr.key_name = 'access_token'
                     and length(cr.ciphertext) > 0) as access_token_present,
          (select max(coalesce(j.finished_at, j.started_at, j.created_at))::text
             from erp.channel_sync_jobs j
             join erp.channel_accounts ca on ca.id = j.channel_account_id
             join erp.sales_channels ch on ch.id = ca.channel_id
            where ca.organization_id = ${org}
              and ch.code = 'digikala'
              and j.job_type = 'pull_orders'
              and j.status = 'succeeded') as last_order_pull_at,
          (select max(coalesce(j.finished_at, j.started_at, j.created_at))::text
             from erp.channel_sync_jobs j
             join erp.channel_accounts ca on ca.id = j.channel_account_id
             join erp.sales_channels ch on ch.id = ca.channel_id
            where ca.organization_id = ${org}
              and ch.code = 'digikala'
              and j.job_type in ('push_inventory','push_price')
              and j.status = 'succeeded') as last_push_at,
          (select j.last_error
             from erp.channel_sync_jobs j
             join erp.channel_accounts ca on ca.id = j.channel_account_id
             join erp.sales_channels ch on ch.id = ca.channel_id
            where ca.organization_id = ${org}
              and ch.code = 'digikala'
              and j.last_error is not null
            order by j.created_at desc
            limit 1) as last_error`,
    ]);

    const kpi = kpiRows[0];
    const digikala = digikalaRows[0];

    return {
      salesAmount: kpi?.sales_amount ?? '0',
      salesCount: kpi?.sales_count ?? '0',
      openOrders: kpi?.open_orders ?? '0',
      lowStockCount: kpi?.low_stock ?? '0',
      receivablesAmount: kpi?.receivables ?? '0',
      payablesAmount: kpi?.payables ?? '0',
      cashAmount: kpi?.cash ?? '0',
      products: {
        total: Number(kpi?.products_total ?? '0'),
        active: Number(kpi?.products_active ?? '0'),
        outOfStock: Number(kpi?.products_out_of_stock ?? '0'),
      },
      inventory: {
        onHandTotal: kpi?.inventory_on_hand ?? '0',
        skuCount: Number(kpi?.inventory_sku_count ?? '0'),
      },
      orders: {
        open: Number(kpi?.open_orders ?? '0'),
        today: Number(kpi?.orders_today ?? '0'),
      },
      sales: {
        todayAmount: kpi?.sales_amount ?? '0',
        monthAmount: kpi?.sales_month_amount ?? '0',
      },
      channels: channelRows.map((row) => ({
        accountId: row.account_id,
        name: row.name,
        channelCode: row.channel_code,
        lastSyncAt: row.last_sync_at,
        lastSyncStatus: row.last_sync_status,
        stockPushEnabled: row.stock_push_enabled === true,
      })),
      digikala: {
        connected: digikala?.connected === true,
        accessTokenPresent: digikala?.access_token_present === true,
        lastOrderPullAt: digikala?.last_order_pull_at ?? null,
        lastPushAt: digikala?.last_push_at ?? null,
        lastError: digikala?.last_error ?? null,
      },
      salesSeries: seriesRows.map((row) => ({ date: row.date, amount: row.amount })),
      lowStock: lowStockRows.map((row) => ({
        id: row.id,
        onHand: row.on_hand,
        available: row.available,
        product: { id: row.product_id, name: row.product_name },
        variant: { id: row.variant_id, code: row.variant_code },
      })),
      recentOrders: recentOrderRows.map((row) => ({
        id: row.id,
        orderNumber: row.order_no,
        status: row.status,
        total: row.total,
        orderDate: row.order_date,
        customer:
          row.customer_id === null
            ? null
            : { id: row.customer_id, name: row.customer_name ?? 'مشتری' },
      })),
    };
  }
}
