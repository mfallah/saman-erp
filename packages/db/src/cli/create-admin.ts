import { randomBytes } from 'node:crypto';
import { createDb } from '../client.js';
import { hashPassword } from '../crypto.js';

/**
 * Create (or reset) a staff admin account.
 *   pnpm --filter @saman/db create-admin -- --username ops --mobile 09121234567 --name "مدیر" --role admin
 * Password: --password, or ADMIN_PASSWORD env, or a generated one printed once.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const username = get('--username');
  const mobile = get('--mobile');
  const name = get('--name', 'مدیر سیستم');
  const roleCode = get('--role', 'admin');
  if (!username || !mobile) {
    console.error('usage: create-admin --username <u> --mobile <09xxxxxxxxx> [--name <name>] [--role <code>] [--password <p>]');
    process.exit(2);
  }
  const password = get('--password') ?? process.env.ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
  const sql = createDb();
  try {
    await sql.begin(async (tx) => {
      const org = await tx`SELECT id FROM erp.organizations WHERE id = 1`;
      if (org.length === 0) throw new Error('organization not seeded; run db:migrate && db:seed first');
      const hash = hashPassword(password);
      const user = await tx`
        INSERT INTO erp.users (organization_id, username, mobile, full_name, password_hash, must_change_password, status)
        VALUES (1, ${username}, ${mobile}, ${name}, ${hash}, true, 'active')
        ON CONFLICT (organization_id, username) DO UPDATE SET password_hash = excluded.password_hash,
          must_change_password = true, status = 'active', failed_login_count = 0, locked_until = null
        RETURNING id, public_id`;
      const role = await tx`SELECT id FROM erp.roles WHERE organization_id = 1 AND code = ${roleCode}`;
      if (role.length === 0) throw new Error(`role not found: ${roleCode}`);
      await tx`INSERT INTO erp.user_roles (user_id, role_id) VALUES (${user[0]!.id}, ${role[0]!.id})
               ON CONFLICT (user_id, role_id) DO NOTHING`;
      await tx`UPDATE erp.users SET permissions_version = permissions_version + 1 WHERE id = ${user[0]!.id}`;
      console.log(`[create-admin] user=${username} role=${roleCode} public_id=${user[0]!.public_id}`);
      console.log(`[create-admin] password=${password} (must_change_password=true)`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[create-admin] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
