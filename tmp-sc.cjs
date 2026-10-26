const postgres=require('postgres');
(async()=>{const sql=postgres('postgres://postgres:WDFTa804vxggY2JN@services.irn18.chabokan.net:42140/benjamin',{max:1});
const a=await sql`select id,public_id,name,seller_code,settings from erp.channel_accounts a join erp.sales_channels c on c.id=a.channel_id where c.code='digikala' and a.deleted_at is null`;
console.log(JSON.stringify(a,null,1));
await sql.end({timeout:1});})().catch(e=>console.log('ERR',e.message));
