const postgres = require('postgres');
const url = 'postgres://postgres:WDFTa804vxggY2JN@212.33.206.173:42140/benjamin';
(async () => {
  const sql = postgres(url, { max: 1, ssl: false, connect_timeout: 20 });
  try {
    const rows = await sql`
      select o.id::text, o.order_no, o.external_order_id, o.order_date::text, o.created_at::text,
             l.sku_snapshot
      from erp.sales_order_lines l join erp.sales_orders o on o.id = l.order_id
      order by o.id`;
    console.log(rows);
    const acct = await sql`
      select id::text, public_id::text, organization_id::text, name, is_active, settings
      from erp.channel_accounts where id = 204`;
    console.log(acct.map((a) => ({ ...a, settings: JSON.stringify(a.settings).slice(0, 400) })));
  } finally {
    await sql.end({ timeout: 5 });
  }
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
