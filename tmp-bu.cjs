const postgres=require('postgres');
(async()=>{const sql=postgres('postgres://postgres:WDFTa804vxggY2JN@services.irn18.chabokan.net:42140/benjamin',{max:1});
const a=await sql`select id,public_id,name,base_url,auth_type,settings from erp.channel_accounts where code=(select id from erp.sales_channels where code='digikala') or name like '%دیجی%'`;
console.log(JSON.stringify(a.map(x=>({id:x.id,pid:x.public_id,name:x.name,base:x.base_url,at:x.auth_type}))));
await sql.end({timeout:1});})().catch(e=>console.log('ERR',e.message));
