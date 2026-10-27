import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb } from './client.js';
import { hashPassword } from './crypto.js';
import { PERMISSIONS } from './generated/permissions.js';
import { CHART_OF_ACCOUNTS } from './generated/coa.js';
import { TABLES } from './schema/spec.js';

type Sql = ReturnType<typeof createDb>;

/** Seed writes master data: run as the migration role, never the runtime role. */
function adminUrl(): string | undefined {
  const file = process.env.MIGRATION_DATABASE_URL_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  const direct = process.env.MIGRATION_DATABASE_URL;
  if (direct && direct.length > 0) return direct;
  return process.env.DATABASE_URL;
}

const log = (msg: string) => console.log('[seed] ' + msg);
let ORG_ID = 1;

const ROLES: { code: string; name: string; scope: string }[] = [
  { code: 'superadmin', name: 'مدیر سیستم', scope: 'all' },
  { code: 'admin', name: 'مدیر کل', scope: 'all' },
  { code: 'finance_manager', name: 'مدیر مالی', scope: 'all' },
  { code: 'accountant', name: 'حسابدار', scope: 'branch' },
  { code: 'warehouse_manager', name: 'مدیر انبار', scope: 'warehouse' },
  { code: 'warehouse_operator', name: 'انباردار', scope: 'warehouse' },
  { code: 'sales_agent', name: 'کارشناس فروش', scope: 'branch' },
  { code: 'viewer', name: 'ناظر', scope: 'all' },
];

const prefix = (k: string, ps: string[]) => ps.some((p) => k.startsWith(p));
const exact = (k: string, xs: string[]) => xs.includes(k);

/** role → permission keys manifest (exact keys from the generated registry; no wildcard matching in DB). */
function grantsFor(role: string, all: string[]): string[] {
  const READ_SENSITIVE = ['product.cost.read', 'audit.read', 'audit.export', 'security_event.read', 'identity.break_glass.use', 'channel.api_call.read', 'channel.webhook.read', 'system.metrics.read', 'system.backup.read', 'system.maintenance.read'];
  switch (role) {
    case 'superadmin':
      return all;
    case 'admin':
      return all.filter((k) => k !== 'identity.break_glass.use');
    case 'finance_manager':
      return all.filter((k) =>
        prefix(k, ['accounting.', 'payment', 'bank.', 'cash', 'cheque', 'reconciliation', 'partner', 'shareholder', 'profit.distribution', 'settlement', 'report', 'dashboard', 'price.list', 'pricing', 'price.snapshot', 'marketplace.fee']) ||
        exact(k, ['sales.refund.approve', 'inventory.valuation.read', 'inventory.valuation.run', 'sales.order.read', 'purchase.order.read', 'supplier.read', 'customer.read', 'inventory.balance.read', 'inventory.ledger.read']));
    case 'accountant':
      return all.filter((k) => exact(k, [
        'accounting.journal.read', 'accounting.journal.create', 'accounting.journal.update', 'accounting.journal.post',
        'accounting.coa.read', 'accounting.dimension.read', 'accounting.period.read', 'accounting.ledger.read',
        'accounting.balance.read', 'accounting.tax.read', 'accounting.link.read', 'accounting.valuation.read',
        'payment.read', 'payment.create', 'payment.submit', 'cheque.read', 'cheque.issue', 'cheque.deposit',
        'bank.account.read', 'cash.transaction.read', 'cash.transaction.create', 'report.read', 'report.run',
        'customer.invoice.read', 'sales.order.read', 'inventory.balance.read',
      ]));
    case 'warehouse_manager':
      return all.filter((k) => prefix(k, ['warehouse', 'inventory']) || exact(k, [
        'goods.receipt.read', 'goods.receipt.create', 'goods.receipt.execute', 'goods.receipt.update',
        'purchase.order.read', 'sales.order.read', 'fulfillment.allocate', 'shipment.read', 'shipment.create',
        'reorder.rule.read', 'reorder.rule.create', 'reorder.rule.update', 'label.read', 'package.read',
      ]) && !exact(k, ['product.cost.read']));
    case 'warehouse_operator':
      return all.filter((k) => exact(k, [
        'warehouse.pick.read', 'warehouse.pick', 'warehouse.pack.read', 'warehouse.pack',
        'warehouse.putaway.read', 'warehouse.putaway', 'warehouse.wave.read', 'warehouse.device.read',
        'inventory.balance.read', 'inventory.transfer.read', 'inventory.lot.read', 'inventory.serial.read', 'inventory.unit.read',
        'goods.receipt.execute', 'label.read', 'label.reprint',
      ]));
    case 'sales_agent':
      return all.filter((k) => prefix(k, ['customer.']) || exact(k, [
        'sales.order.read', 'sales.order.create', 'sales.order.update', 'sales.return.read', 'sales.return.create',
        'sales.refund.read', 'sales.refund.create', 'customer.credit.read', 'customer.invoice.read',
        'shipment.read', 'report.read', 'report.run', 'dashboard.read', 'inventory.balance.read', 'price.snapshot.read',
      ]));
    case 'viewer':
      return all.filter((k) => k.endsWith('.read') && !READ_SENSITIVE.includes(k));
    default:
      return [];
  }
}

const UNITS: [string, string, string, string, boolean, number][] = [
  ['PCS', 'عدد', 'عددی', 'count', true, 0],
  ['KG', 'کیلوگرم', 'kg', 'mass', true, 3],
  ['G', 'گرم', 'g', 'mass', false, 3],
  ['L', 'لیتر', 'L', 'volume', true, 3],
  ['ML', 'میلی‌لیتر', 'ml', 'volume', false, 3],
  ['M', 'متر', 'm', 'length', true, 2],
  ['CM', 'سانتی‌متر', 'cm', 'length', false, 2],
  ['M2', 'مترمربع', 'm²', 'area', true, 4],
  ['PACK', 'بسته', 'pack', 'package', false, 0],
  ['CARTON6', 'کارتن ۶تایی', 'ctn6', 'package', false, 0],
  ['CARTON12', 'کارتن ۱۲تایی', 'ctn12', 'package', false, 0],
  ['SHANE30', 'شانه ۳۰تایی', 'sh30', 'package', false, 0],
  ['PAIR', 'جفت', 'pair', 'count', false, 0],
  ['SET', 'ست', 'set', 'count', false, 0],
];
const CONVERSIONS: [string, string, string][] = [
  ['G', 'KG', '0.001'], ['ML', 'L', '0.001'], ['CM', 'M', '0.01'],
  ['CARTON6', 'PCS', '6'], ['CARTON12', 'PCS', '12'], ['SHANE30', 'PCS', '30'], ['PACK', 'PCS', '1'], ['PAIR', 'PCS', '2'], ['SET', 'PCS', '1'],
];

const TAX_RATES: [string, string, string, string][] = [
  ['VAT-10', 'مالیات بر ارزش افزوده ۱۰٪', 'vat', '0.100000'],
  ['VAT-0', 'معاف از مالیات', 'exempt', '0.000000'],
  ['WHT-3', 'مالیات تکلیفی ۳٪', 'withholding', '0.030000'],
];

const NUMBERING: [string, string][] = [
  ['sales_order', 'SLS'], ['customer_invoice', 'INV'], ['sales_return', 'RMA'], ['refund', 'RFD'],
  ['purchase_order', 'PO'], ['goods_receipt', 'GRN'], ['supplier_invoice', 'PINV'], ['stock_adjustment', 'ADJ'],
  ['stock_count', 'CNT'], ['inventory_transfer', 'TRF'], ['journal_entry', 'JV'], ['payment', 'PAY'],
  ['cheque', 'CHQ'], ['bank_reconciliation', 'BRC'], ['expense', 'EXP'], ['tax_document', 'TAX'],
  ['settlement', 'SET'], ['profit_distribution', 'PRF'],
];

const CHANNELS: [string, string, string, boolean, boolean, boolean, boolean][] = [
  ['carexy', 'فروشگاه کرکسی', 'storefront', true, true, true, false],
  ['digikala', 'دیجی‌کالا', 'marketplace', true, true, true, true],
  ['snapp', 'اسنپ‌شاپ', 'marketplace', true, true, true, false],
  ['tapsi', 'تپسی‌شاپ', 'marketplace', true, true, true, false],
  ['manual_pos', 'فروش دستی', 'pos', false, false, false, false],
  ['mock', 'آزمایشی', 'test', true, true, true, true],
];

const SETTINGS: [string, string][] = [
  ['general.timezone', '"Asia/Tehran"'], ['general.locale', '"fa-IR"'], ['general.date_display', '"jalali"'],
  ['inventory.valuation_method', '"moving_average"'], ['inventory.allow_negative_stock', 'false'],
  ['inventory.default_safety_stock', '0'], ['inventory.reservation_ttl_minutes', '30'],
  ['sales.rounding_account', '"5-2-14-001"'], ['sales.header_discount_distribution', '"largest_remainder"'],
  ['fulfillment.free_shipping_threshold', '20000000'], ['pricing.rounding_mode', '"nearest_1000"'],
  ['accounting.auto_post_sales', 'true'], ['accounting.auto_post_purchase', 'true'],
  ['accounting.journal_approval_threshold', '100000000'], ['accounting.legal_reserve_percent', '0.05'],
  ['accounting.legal_reserve_cap_percent', '0.10'],
  ['security.otp_ttl_seconds', '120'], ['security.session_absolute_days', '7'],
  ['security.max_login_failures', '10'], ['security.lockout_minutes', '15'],
  ['security.audit_retention_years', '10'], ['channels.stock_push_debounce_seconds', '3'],
  ['files.max_upload_mb', '20'], ['files.persist_http_bodies_in_prod', 'false'],
];

const PARTITIONS: [string, number | null, boolean, number | null][] = [
  ['inventory_transactions', 25, true, 6],
  ['audit_logs', 120, true, 12],
  ['api_request_logs', 3, false, 3],
  ['channel_api_calls', 6, false, 6],
  ['outbox_events', 1, false, 1],
];

const ENUM_VALUES: [string, string, string][] = [
  ['otp_purpose', 'login', 'ورود'], ['otp_purpose', 'device_trust', 'اعتماد دستگاه'], ['otp_purpose', 'password_change', 'تغییر رمز'],
  ['otp_purpose', 'password_reset', 'بازیابی رمز'], ['otp_purpose', 'action_confirm', 'تأیید عملیات'], ['otp_purpose', 'step_up', 'احراز هویت مرحله‌ای'],
  ['otp_purpose', 'mfa', 'ورود دو مرحله‌ای'], ['otp_purpose', 'channel_credential', 'اعتبارنامه کانال'], ['otp_purpose', 'breakglass', 'دسترسی اضطراری'],
  ['security_event_type', 'login.success', 'ورود موفق'], ['security_event_type', 'login.failure', 'ورود ناموفق'],
  ['security_event_type', 'login.locked', 'قفل حساب'], ['security_event_type', 'session.reuse_detected', 'استفاده مجدد توکن'],
  ['security_event_type', 'permission.denied', 'عدم دسترسی'], ['security_event_type', 'audit_mismatch', 'ناسازگاری زنجیره حسابرسی'],
  ['dead_letter_integration', 'carexy', 'کرکسی'], ['dead_letter_integration', 'digikala', 'دیجی‌کالا'],
  ['dead_letter_integration', 'limo_sms', 'لیمو'], ['dead_letter_integration', 'partition_maintenance', 'نگهداری پارتیشن'],
  ['dead_letter_integration', 'webhook_outbound', 'وبهوک خروجی'],
];

/** current Iranian fiscal year (1405) mapped to Gregorian civil days */
function fiscalYear1405(): { start: string; end: string } {
  return { start: '2026-03-21', end: '2027-03-20' };
}

function monthsFrom(start: string): string[][] {
  const out: string[][] = [];
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < 12; i++) {
    const s = new Date(d);
    s.setUTCMonth(d.getUTCMonth() + i);
    const e = new Date(s);
    e.setUTCMonth(s.getUTCMonth() + 1);
    e.setUTCDate(e.getUTCDate() - 1);
    out.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
  }
  return out;
}

export async function seed(url = adminUrl()): Promise<Record<string, number>> {
  const sql = createDb(url);
  const counts: Record<string, number> = {};
  try {
    await sql.begin(async (tx) => {
      // organization — resolve the real identity value instead of assuming id=1
      // (a rolled-back earlier seed still advances the identity sequence).
      const existingOrg = await tx<{ id: string }[]>`SELECT id::text AS id FROM erp.organizations ORDER BY id LIMIT 1`;
      if (existingOrg.length === 0) {
        const inserted = await tx<{ id: string }[]>`INSERT INTO erp.organizations (name, legal_name, base_currency, timezone, valuation_method)
                 VALUES ('Carexy Shop', 'فروشگاه کرکسی', 'IRR', 'Asia/Tehran', 'moving_average') RETURNING id::text AS id`;
        ORG_ID = Number(inserted[0]?.id ?? 1);
      } else {
        ORG_ID = Number(existingOrg[0]?.id ?? 1);
      }
      counts.organizations = 1;

      // permissions (single generated registry)
      for (const p of PERMISSIONS) {
        const desc = p.key.replace(/\./g, ' › ');
        await tx`INSERT INTO erp.permissions (key, resource, action, description_fa, is_system, module)
                 VALUES (${p.key}, ${p.resource}, ${p.action}, ${desc}, true, ${p.module})
                 ON CONFLICT (key) DO UPDATE SET resource = excluded.resource, action = excluded.action, module = excluded.module`;
      }
      counts.permissions = PERMISSIONS.length;
      const allKeys = PERMISSIONS.map((p) => p.key);

      // roles + grants
      for (const r of ROLES) {
        await tx`INSERT INTO erp.roles (organization_id, code, name, is_system, scope_mode)
                 VALUES (${ORG_ID}, ${r.code}, ${r.name}, true, ${r.scope})
                 ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO UPDATE SET name = excluded.name, scope_mode = excluded.scope_mode`;
        const role = await tx`SELECT id FROM erp.roles WHERE organization_id = ${ORG_ID} AND code = ${r.code}`;
        const roleId = role[0]!.id as number;
        const grants = grantsFor(r.code, allKeys);
        for (const key of grants) {
          await tx`INSERT INTO erp.role_permissions (role_id, permission_id)
                   SELECT ${roleId}, id FROM erp.permissions WHERE key = ${key}
                   ON CONFLICT (role_id, permission_id) DO NOTHING`;
        }
        counts[`grants.${r.code}`] = grants.length;
      }

      // CoA manifest (parents first)
      const codeToId = new Map<string, number>();
      for (const row of CHART_OF_ACCOUNTS) {
        const parentCode = row.code.split('-').slice(0, -1).join('-');
        const parentId = row.code.includes('-') ? (codeToId.get(parentCode) ?? null) : null;
        const inserted = await tx`
          INSERT INTO erp.chart_of_accounts
            (organization_id, code, name_fa, account_level, parent_id, account_type, normal_balance, nature, is_postable, is_active, currency)
          VALUES (${ORG_ID}, ${row.code}, ${row.name}, ${row.code.split('-').length}, ${parentId},
                  ${row.accountType}, ${row.normalBalance}, ${row.nature}, ${row.isPostable}, true, 'IRR')
          ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO UPDATE SET name_fa = excluded.name_fa
          RETURNING id`;
        codeToId.set(row.code, inserted[0]!.id as number);
      }
      counts.chart_of_accounts = CHART_OF_ACCOUNTS.length;

      // units + conversions
      for (const [code, name, symbol, dimension, isBase, precision] of UNITS) {
        await tx`INSERT INTO erp.units_of_measure (organization_id, code, name, symbol, dimension, is_base, decimal_precision)
                 VALUES (${ORG_ID}, ${code}, ${name}, ${symbol}, ${dimension}, ${isBase}, ${precision})
                 ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO NOTHING`;
      }
      const unitRows = await tx<{ id: number; code: string }[]>`SELECT id, code FROM erp.units_of_measure WHERE organization_id = ${ORG_ID}`;
      const unitByCode = new Map(unitRows.map((u) => [u.code, u.id]));
      for (const [from, to, factor] of CONVERSIONS) {
        const f = unitByCode.get(from); const t = unitByCode.get(to);
        if (!f || !t) continue;
        await tx`INSERT INTO erp.unit_conversions (organization_id, from_unit_id, to_unit_id, factor, is_exact)
                 VALUES (${ORG_ID}, ${f}, ${t}, ${factor}, true) ON CONFLICT (from_unit_id, to_unit_id) WHERE deleted_at IS NULL DO NOTHING`;
        await tx`INSERT INTO erp.unit_conversions (organization_id, from_unit_id, to_unit_id, factor, is_exact)
                 VALUES (${ORG_ID}, ${t}, ${f}, ${String(1 / Number(factor))}, true) ON CONFLICT (from_unit_id, to_unit_id) WHERE deleted_at IS NULL DO NOTHING`;
      }
      counts.units_of_measure = UNITS.length;

      // tax rates (gl mapping filled by accounting implementation; nullable here)
      for (const [code, name, type, rate] of TAX_RATES) {
        await tx`INSERT INTO erp.tax_rates (organization_id, code, name_fa, tax_type, rate_percent, effective_from, is_default)
                 VALUES (${ORG_ID}, ${code}, ${name}, ${type}, ${rate}, '2025-03-21', ${code === 'VAT-10'})
                 ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO NOTHING`;
      }
      counts.tax_rates = TAX_RATES.length;

      // price lists before channel accounts
      await tx`INSERT INTO erp.price_lists (organization_id, code, name, list_type, currency, rounding_mode, priority)
               VALUES (${ORG_ID}, 'BASE', 'لیست قیمت پایه', 'retail', 'IRR', 'nearest_1000', 10)
               ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO NOTHING`;
      const baseList = await tx`SELECT id FROM erp.price_lists WHERE organization_id = ${ORG_ID} AND code = 'BASE'`;

      // fiscal year + periods
      const fy = fiscalYear1405();
      const fyRow = await tx`INSERT INTO erp.fiscal_years (organization_id, code, title, start_date, end_date, status)
                             VALUES (${ORG_ID}, '1405', 'سال مالی ۱۴۰۵', ${fy.start}, ${fy.end}, 'open')
                             ON CONFLICT (organization_id, code) DO UPDATE SET title = excluded.title
                             RETURNING id`;
      const fiscalYearId = fyRow[0]!.id as number;
      const months = monthsFrom(fy.start);
      for (let i = 0; i < months.length; i++) {
        await tx`INSERT INTO erp.accounting_periods (fiscal_year_id, period_no, name_fa, start_date, end_date, status)
                 VALUES (${fiscalYearId}, ${i + 1}, ${`دوره ${i + 1}`}, ${months[i]![0]}, ${months[i]![1]}, 'open')
                 ON CONFLICT (fiscal_year_id, period_no) DO NOTHING`;
      }
      counts.accounting_periods = months.length;

      // numbering sequences per type/year
      for (const [docType, prefix] of NUMBERING) {
        await tx`INSERT INTO erp.numbering_sequences (organization_id, document_type, fiscal_year_id, prefix, next_value, padding, reset_policy)
                 VALUES (${ORG_ID}, ${docType}, ${fiscalYearId}, ${prefix}, 1, 6, 'fiscal_year')
                 ON CONFLICT (organization_id, document_type, fiscal_year_id) DO NOTHING`;
      }
      counts.numbering_sequences = NUMBERING.length;

      // channels + accounts + fee rules
      for (const [code, name, type, stock, price, orders, label] of CHANNELS) {
        await tx`INSERT INTO erp.sales_channels (organization_id, code, name, channel_type, supports_stock_push, supports_price_push, supports_order_pull, supports_webhook, supports_label, is_active)
                 VALUES (${ORG_ID}, ${code}, ${name}, ${type}, ${stock}, ${price}, ${orders}, true, ${label}, ${code !== 'snapp' && code !== 'tapsi'})
                 ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO NOTHING`;
      }
      const channelRows = await tx<{ id: number; code: string }[]>`SELECT id, code FROM erp.sales_channels WHERE organization_id = ${ORG_ID}`;
      const channelByCode = new Map(channelRows.map((c) => [c.code, c.id]));
      const ACCOUNTS: [string, string, string, string, number][] = [
        ['carexy', 'carexy-main', 'فروشگاه کرکسی - اصلی', 'api_key', 120],
        ['digikala', 'digikala-main', 'دیجی‌کالا - اصلی', 'oauth2_client_credentials', 60],
        ['mock', 'mock-test', 'حساب آزمایشی', 'api_key', 1000],
      ];
      for (const [chCode, name, label, authType, rate] of ACCOUNTS) {
        const ch = channelByCode.get(chCode);
        if (!ch) continue;
        // Idempotent even after a soft delete: never resurrect an account the
        // operator removed (the partial unique index only covers live rows, so
        // ON CONFLICT alone re-created deleted accounts on every boot).
        await tx`INSERT INTO erp.channel_accounts (channel_id, organization_id, name, external_account_id, auth_type, rate_limit_per_min, price_list_id, is_active)
                 SELECT ${ch}, ${ORG_ID}, ${label}, ${name}, ${authType}, ${rate}, ${baseList[0]?.id ?? null}, true
                 WHERE NOT EXISTS (
                   SELECT 1 FROM erp.channel_accounts
                   WHERE channel_id = ${ch} AND organization_id = ${ORG_ID} AND external_account_id = ${name}
                 )`;
      }
      counts.channels = CHANNELS.length;

      // settings
      for (const [key, value] of SETTINGS) {
        await tx`INSERT INTO erp.system_settings (organization_id, key, value_json, is_secret)
                 VALUES (${ORG_ID}, ${key}, ${value}::jsonb, false)
                 ON CONFLICT (organization_id, key) DO UPDATE SET value_json = excluded.value_json`;
      }
      counts.system_settings = SETTINGS.length;

      // partition registry + enum values
      for (const [table, retention, archive, hot] of PARTITIONS) {
        await tx`INSERT INTO erp.partitioned_tables_registry (parent_table, retention_months, archive_to_s3, hot_months, is_enabled)
                 VALUES (${table}, ${retention}, ${archive}, ${hot}, true)
                 ON CONFLICT (parent_table) DO NOTHING`;
      }
      for (const [domain, value, label] of ENUM_VALUES) {
        await tx`INSERT INTO erp.enum_values (domain, value, label_fa) VALUES (${domain}, ${value}, ${label})
                 ON CONFLICT (domain, value) DO NOTHING`;
      }
      counts.enum_values = ENUM_VALUES.length;

      // bootstrap superadmin (idempotent by username)
      const existing = await tx`SELECT id FROM erp.users WHERE organization_id = ${ORG_ID} AND username = 'admin'`;
      if (existing.length === 0) {
        const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
        await tx`INSERT INTO erp.users (organization_id, username, mobile, full_name, password_hash, must_change_password, status, mfa_enabled)
                 VALUES (${ORG_ID}, 'admin', ${process.env.BOOTSTRAP_ADMIN_MOBILE ?? '09120000000'}, 'مدیر سیستم', ${hashPassword(password)}, true, 'active', false)`;
        const user = await tx`SELECT id FROM erp.users WHERE organization_id = ${ORG_ID} AND username = 'admin'`;
        const superadmin = await tx`SELECT id FROM erp.roles WHERE organization_id = ${ORG_ID} AND code = 'superadmin'`;
        await tx`INSERT INTO erp.user_roles (user_id, role_id) VALUES (${user[0]!.id}, ${superadmin[0]!.id})
                 ON CONFLICT (user_id, role_id) DO NOTHING`;
        console.log('==============================================================');
        console.log(' BOOTSTRAP SUPERADMIN CREATED');
        console.log('   username: admin');
        console.log('   mobile  : ' + (process.env.BOOTSTRAP_ADMIN_MOBILE ?? '09120000000'));
        console.log('   password: ' + (process.env.BOOTSTRAP_ADMIN_PASSWORD ? '(from BOOTSTRAP_ADMIN_PASSWORD)' : password));
        console.log('   must_change_password = true — change after first login.');
        console.log('==============================================================');
      }
      counts.users = 1;
      counts.tables_in_manifest = TABLES.length;
    });
    log('done ' + JSON.stringify(counts));
    return counts;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

declare const require: NodeJS.Require;
declare const module: NodeJS.Module;

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    });
}
