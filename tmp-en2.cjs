const postgres=require('postgres');
(async()=>{const sql=postgres('postgres://postgres:WDFTa804vxggY2JN@services.irn18.chabokan.net:42140/benjamin',{max:1});
const e=await sql`select distinct type from erp.inventory_transactions`;
console.log('types',JSON.stringify(e));
const r=await sql`select status from erp.goods_receipts group by status`;
console.log('receipt statuses',JSON.stringify(r));
const c=await sql`select a.name, c.key_name from erp.channel_credentials c join erp.channel_accounts a on a.id=c.channel_account_id where c.is_active`;
console.log('creds',JSON.stringify(c));
await sql.end({timeout:1});})().catch(e=>console.log('ERR',e.message));
