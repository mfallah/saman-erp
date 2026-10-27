const postgres = require('postgres');

const url = 'postgres://postgres:WDFTa804vxggY2JN@212.33.206.173:42140/benjamin';

(async () => {
  const sql = postgres(url, { max: 1, ssl: false, connect_timeout: 20 });
  try {
    const cols = await sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'erp'
        and table_name in ('sales_order_lines','products','product_variants')
        and column_name in ('external_title','image_url','title_snapshot','sku_snapshot','name','title')
      order by table_name, column_name`;
    console.log('COLUMNS', cols);

    const mig = await sql`select version from public.schema_migrations order by version`;
    console.log('MIGRATIONS', mig.map((r) => r.version));

    const lines = await sql`
      select l.id::text, l.order_id::text, l.product_variant_id::text, l.sku_snapshot, l.title_snapshot,
             o.external_order_id, o.order_no, o.channel_account_id::text
      from erp.sales_order_lines l
      join erp.sales_orders o on o.id = l.order_id
      where o.channel_account_id is not null
      order by l.id desc
      limit 40`;
    console.log('LINES', lines);

    const counts = await sql`
      select count(*)::int as total,
             count(*) filter (where l.title_snapshot = 'کالای نامشخص کانال')::int as placeholder
      from erp.sales_order_lines l`;
    console.log('COUNTS', counts);
  } finally {
    await sql.end({ timeout: 5 });
  }
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
