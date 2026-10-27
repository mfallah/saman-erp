const postgres=require('postgres');
(async()=>{const sql=postgres('postgres://postgres:WDFTa804vxggY2JN@services.irn18.chabokan.net:42140/benjamin',{max:1});
const s=await sql`select settings->>'digikalaReconcileAt' at from erp.channel_accounts where id=204`;
const c=await sql`select operation,http_status,created_at from erp.channel_api_calls order by id desc limit 5`;
console.log('stamp',JSON.stringify(s),'calls',JSON.stringify(c));
await sql.end({timeout:1});})().catch(e=>console.log('ERR',e.message));
