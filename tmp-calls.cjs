const postgres=require('postgres');
(async()=>{const sql=postgres('postgres://postgres:WDFTa804vxggY2JN@services.irn18.chabokan.net:42140/benjamin',{max:1});
const c=await sql`select column_name,data_type from information_schema.columns where table_schema='erp' and table_name='channel_api_calls' order by ordinal_position`;
console.log(c.map(x=>x.column_name).join(', '));
const rows=await sql`select channel_account_id, operation, method, endpoint, http_status, success, left(response_payload::text,300) resp, left(error_code::text,40) err, created_at from erp.channel_api_calls where channel_account_id in (189,196) order by id desc limit 15`;
console.log(JSON.stringify(rows));
await sql.end({timeout:1});})().catch(e=>console.log('ERR',e.message));
