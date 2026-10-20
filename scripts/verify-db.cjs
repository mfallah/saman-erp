/* Real-database verification for Saman ERP v1.0 (PostgreSQL 18.4 local cluster). */
const postgres = require('postgres');

const URL = process.env.MIGRATION_DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 110) : ''}`);
}

(async () => {
  const sql = postgres(URL, { max: 2, connect_timeout: 10, onnotice: () => {} });
  try {
    const t = await sql`select count(*)::int n from information_schema.tables where table_schema='erp'`;
    check('schema erp tables >= 200', t[0].n >= 200, `${t[0].n}`);
    const funcs = await sql`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='erp'`;
    check('helper functions >= 8', funcs[0].n >= 8, `${funcs[0].n}`);
    const trg = await sql`select count(*)::int n from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='erp' and not tg.tgisinternal`;
    check('triggers attached >= 300', trg[0].n >= 300, `${trg[0].n}`);
    const parts = await sql`select count(*)::int n from pg_partitioned_table pt join pg_class c on c.oid=pt.partrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='erp'`;
    check('partitioned parents = 5', parts[0].n === 5, `${parts[0].n}`);
    const children = await sql`select count(*)::int n from pg_inherits i join pg_class c on c.oid=i.inhparent join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='erp'`;
    check('partition children >= 15', children[0].n >= 15, `${children[0].n}`);

    const appDel = await sql`select count(*)::int n from information_schema.role_table_grants where grantee='saman_app' and table_schema='erp' and privilege_type='DELETE'`;
    check('saman_app has NO DELETE grant', appDel[0].n === 0, `${appDel[0].n}`);
    const roSecret = await sql`select count(*)::int n from information_schema.role_table_grants where grantee='saman_readonly' and table_schema='erp' and table_name in ('users','auth_sessions','password_history','security_events','audit_logs','system_settings')`;
    check('saman_readonly cannot read secret tables', roSecret[0].n === 0, `${roSecret[0].n}`);

    const perms = await sql`select count(*)::int n from erp.permissions`;
    check('permissions seeded = 414', perms[0].n === 414, `${perms[0].n}`);
    const coa = await sql`select count(*)::int n from erp.chart_of_accounts where deleted_at is null`;
    check('chart of accounts >= 160', coa[0].n >= 160, `${coa[0].n}`);
    const grants = await sql`select count(*)::int n from erp.role_permissions`;
    check('role grants > 700', grants[0].n > 700, `${grants[0].n}`);
    const admin = await sql`select username, password_hash, status from erp.users order by id limit 1`;
    check('bootstrap admin exists', admin.length === 1 && admin[0].status === 'active', admin[0]?.username);

    if (ADMIN_PASSWORD && admin[0]) {
      try {
        const pwdSvc = require('./apps/api/dist/modules/identity/password.service.js');
        const service = new pwdSvc.PasswordService();
        const ok = await service.verifyPassword(admin[0].password_hash, ADMIN_PASSWORD);
        check('seeded admin password verifies via API password service', ok === true, ok ? 'scrypt path OK' : 'verify returned false');
      } catch (e) {
        check('seeded admin password verifies via API password service', false, e.message);
      }
    }

    // journal balance: balanced header but unbalanced lines must be rejected at COMMIT (deferred constraint trigger)
    try {
      const fy = await sql`select id from erp.fiscal_years order by id limit 1`;
      const period = await sql`select id, start_date from erp.accounting_periods where fiscal_year_id=${fy[0].id} order by period_no limit 1`;
      const org = await sql`select id from erp.organizations order by id limit 1`;
      const acc = await sql`select id from erp.chart_of_accounts where is_postable order by id limit 2`;
      let rejected = false;
      let msg = '';
      try {
        await sql.begin(async (tx) => {
          const ins = await tx`
            insert into erp.journal_entries
              (organization_id, fiscal_year_id, period_id, entry_no, entry_date, business_date, entry_type, status,
               total_debit_amount, total_credit_amount, description)
            values (${org[0].id}, ${fy[0].id}, ${period[0].id}, 'VERIFY-1', ${period[0].start_date}, ${period[0].start_date}, 'manual', 'posted', 150, 150, 'آزمون تعادل')
            returning id`;
          await tx`insert into erp.journal_lines (journal_entry_id, line_no, account_id, debit_amount, credit_amount)
                   values (${ins[0].id}, 1, ${acc[0].id}, 200, 0), (${ins[0].id}, 2, ${acc[1].id}, 0, 100)`;
        });
      } catch (e) {
        rejected = true;
        msg = e.message;
      }
      check('unbalanced posted journal rejected at commit', rejected, msg);
    } catch (e) {
      check('unbalanced posted journal rejected at commit', false, 'setup error: ' + e.message);
    }

    const cks = await sql`select conname, pg_get_constraintdef(oid) def from pg_constraint
      where conrelid='erp.inventory_balances'::regclass and contype='c'`;
    const guard = cks.find((c) => c.def.includes('safety_buffer') && c.def.includes('on_hand') && c.def.includes('reserved'));
    check('availability CHECK reserved+safety_buffer+damaged <= on_hand', Boolean(guard), guard?.conname);

    try {
      const org = await sql`select id from erp.organizations order by id limit 1`;
      await sql`insert into erp.audit_logs (organization_id, actor_type, action, entity_type, entity_id, request_id)
                values (${org[0].id}, 'system', 'verify.run', 'system', 1, gen_random_uuid())`;
      const chained = await sql`select erp.chain_audit(50) as n`;
      const hashed = await sql`select count(*)::int n from erp.audit_logs where entry_hash is not null`;
      check('audit hash chain executes', Number(chained[0].n) >= 1 && hashed[0].n >= 1, `chained=${chained[0].n}, hashed=${hashed[0].n}`);
    } catch (e) {
      check('audit hash chain executes', false, e.message);
    }

    const grantExec = await sql`select has_function_privilege('saman_worker','erp.maintain_partitions(integer)','EXECUTE') ok`;
    check('worker can execute partition maintenance', grantExec[0].ok === true);

    const triggers = await sql`select tgname from pg_trigger where tgname in
      ('trg_journal_entries_assert_balanced','trg_journal_lines_assert_balanced')`;
    check('journal balance constraint triggers exist', triggers.length === 2, triggers.map((r) => r.tgname).join(','));
  } catch (e) {
    console.error('VERIFY CRASH:', e.message);
  } finally {
    await sql.end({ timeout: 2 });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
