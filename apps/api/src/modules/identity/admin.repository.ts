import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';

import { DB, type Db } from '../../common/contracts';

export type SqlClient = Sql<Record<string, unknown>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new RangeError('expected_bigint');
}

export function optionalBigInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toBigInt(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface AdminUserRow {
  readonly publicId: string;
  readonly username: string;
  readonly mobile: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly status: string;
  readonly mustChangePassword: boolean;
  readonly permissionsVersion: number;
  readonly roles: string[];
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

/** Admin/platform repositories (`API.md` §4.1, §4.2, §4.17, §4.18). */
@Injectable()
export class AdminRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private get sql(): SqlClient {
    return this.db as unknown as SqlClient;
  }

  // --- users ---------------------------------------------------------------

  async listUsers(orgId: bigint, search?: string, limit = 50): Promise<{ items: AdminUserRow[]; total: number }> {
    const pattern = search === undefined ? null : `%${search}%`;
    const rows = await this.sql`
      select u.public_id, u.username, u.mobile, u.full_name, u.email, u.status,
             u.must_change_password, u.permissions_version, u.last_login_at, u.created_at,
             coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as roles
      from erp.users u
      left join erp.user_roles ur on ur.user_id = u.id
      left join erp.roles r on r.id = ur.role_id
      where u.organization_id = ${orgId} and u.deleted_at is null
        and (${pattern}::text is null or u.full_name ilike ${pattern} or u.username ilike ${pattern} or u.mobile like ${pattern})
      group by u.id
      order by u.created_at desc
      limit ${limit}
    `;
    const countRows = await this.sql`
      select count(*)::int as total from erp.users
      where organization_id = ${orgId} and deleted_at is null
        and (${pattern}::text is null or full_name ilike ${pattern} or username ilike ${pattern} or mobile like ${pattern})
    `;
    return {
      items: rows.map((row) => ({
        publicId: String(row['public_id']),
        username: String(row['username']),
        mobile: String(row['mobile']),
        fullName: String(row['full_name']),
        email: row['email'] === null ? null : String(row['email']),
        status: String(row['status']),
        mustChangePassword: row['must_change_password'] === true,
        permissionsVersion: Number(row['permissions_version']),
        roles: ((row['roles'] as unknown[]) ?? []).map(String),
        lastLoginAt: row['last_login_at'] === null ? null : new Date(String(row['last_login_at'])).toISOString(),
        createdAt: new Date(String(row['created_at'])).toISOString(),
      })),
      total: countRows[0] === undefined ? 0 : Number(countRows[0]['total']),
    };
  }

  async findUserByPublicId(orgId: bigint, publicId: string): Promise<{ id: bigint; publicId: string; permissions: string[] } | null> {
    if (!isUuid(publicId)) return null;
    const rows = await this.sql`
      select u.id, u.public_id,
             coalesce(array_agg(distinct p.key) filter (where p.key is not null), '{}') as permissions
      from erp.users u
      left join erp.user_roles ur on ur.user_id = u.id
      left join erp.role_permissions rp on rp.role_id = ur.role_id
      left join erp.permissions p on p.id = rp.permission_id
      where u.organization_id = ${orgId} and u.public_id = ${publicId}::uuid and u.deleted_at is null
      group by u.id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: toBigInt(row['id']),
      publicId: String(row['public_id']),
      permissions: ((row['permissions'] as unknown[]) ?? []).map(String),
    };
  }

  async createUser(input: {
    orgId: bigint;
    username: string;
    mobile: string;
    fullName: string;
    email: string | null;
    passwordHash: string;
  }): Promise<{ id: bigint; publicId: string }> {
    const rows = await this.sql`
      insert into erp.users (organization_id, username, mobile, full_name, email, password_hash, status, must_change_password, locale)
      values (${input.orgId}, ${input.username}, ${input.mobile}, ${input.fullName}, ${input.email}, ${input.passwordHash}, 'active', true, 'fa-IR')
      returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('user_insert_failed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async updateUser(
    orgId: bigint,
    publicId: string,
    patch: { fullName?: string; email?: string | null; status?: string },
  ): Promise<boolean> {
    if (!isUuid(publicId)) return false;
    const rows = await this.sql`
      update erp.users set
        full_name = coalesce(${patch.fullName ?? null}, full_name),
        email = case when ${patch.email === undefined} then email else ${patch.email ?? null} end,
        status = coalesce(${patch.status ?? null}, status),
        permissions_version = permissions_version + 1
      where organization_id = ${orgId} and public_id = ${publicId}::uuid and deleted_at is null
      returning id
    `;
    return rows.length > 0;
  }

  async setUserPassword(orgId: bigint, publicId: string, passwordHash: string): Promise<boolean> {
    if (!isUuid(publicId)) return false;
    const rows = await this.sql`
      update erp.users set password_hash = ${passwordHash}, password_changed_at = now(),
        must_change_password = true, permissions_version = permissions_version + 1
      where organization_id = ${orgId} and public_id = ${publicId}::uuid and deleted_at is null
      returning id
    `;
    return rows.length > 0;
  }

  async setUserRoles(orgId: bigint, userId: bigint, roleCodes: readonly string[]): Promise<boolean> {
    const roles = await this.sql`select id, code from erp.roles where organization_id = ${orgId}`;
    const byCode = new Map(roles.map((row) => [String(row['code']), toBigInt(row['id'])]));
    const roleIds = roleCodes.map((code) => byCode.get(code)).filter((id): id is bigint => id !== undefined);
    if (roleIds.length !== roleCodes.length) return false;
    // saman_app intentionally has no DELETE; the SECURITY DEFINER RPC performs
    // the replacement transactionally and bumps permissions_version.
    await this.sql`select erp.set_user_roles(${userId}, ${roleIds.map((id) => id.toString())}::bigint[])`;
    return true;
  }

  async setUserScope(orgId: bigint, userId: bigint, branchIds: readonly bigint[], warehouseIds: readonly bigint[]): Promise<void> {
    await this.sql`select erp.set_user_scope(${userId}, ${orgId},
      ${branchIds.map((id) => id.toString())}::bigint[],
      ${warehouseIds.map((id) => id.toString())}::bigint[])`;
  }

  async revokeUserSessions(userId: bigint, reason: string): Promise<number> {
    const rows = await this.sql`
      update erp.auth_sessions set revoked_at = now(), revoke_reason = ${reason}
      where user_id = ${userId} and revoked_at is null returning id
    `;
    return rows.length;
  }

  // --- roles ---------------------------------------------------------------

  async listRoles(orgId: bigint): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      select r.public_id, r.code, r.name, r.description, r.is_system, r.scope_mode,
             coalesce(array_agg(p.key order by p.key) filter (where p.key is not null), '{}') as permissions
      from erp.roles r
      left join erp.role_permissions rp on rp.role_id = r.id
      left join erp.permissions p on p.id = rp.permission_id
      where r.organization_id = ${orgId} and r.deleted_at is null
      group by r.id
      order by r.is_system desc, r.code
    `;
    return rows.map((row) => ({
      id: String(row['public_id']),
      code: String(row['code']),
      name: String(row['name']),
      description: row['description'] === null ? null : String(row['description']),
      isSystem: row['is_system'] === true,
      scopeMode: String(row['scope_mode']),
      permissions: ((row['permissions'] as unknown[]) ?? []).map(String),
    }));
  }

  async findRole(orgId: bigint, publicId: string): Promise<{ id: bigint; isSystem: boolean; permissions: string[] } | null> {
    if (!isUuid(publicId)) return null;
    const rows = await this.sql`
      select r.id, r.is_system,
             coalesce(array_agg(p.key) filter (where p.key is not null), '{}') as permissions
      from erp.roles r
      left join erp.role_permissions rp on rp.role_id = r.id
      left join erp.permissions p on p.id = rp.permission_id
      where r.organization_id = ${orgId} and r.public_id = ${publicId}::uuid and r.deleted_at is null
      group by r.id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: toBigInt(row['id']),
      isSystem: row['is_system'] === true,
      permissions: ((row['permissions'] as unknown[]) ?? []).map(String),
    };
  }

  async createRole(orgId: bigint, input: { code: string; name: string; description: string | null; scopeMode: string }): Promise<{ id: bigint; publicId: string }> {
    const rows = await this.sql`
      insert into erp.roles (organization_id, code, name, description, scope_mode, is_system)
      values (${orgId}, ${input.code}, ${input.name}, ${input.description}, ${input.scopeMode}, false)
      returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('role_insert_failed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async updateRole(orgId: bigint, publicId: string, patch: { name?: string; description?: string | null; scopeMode?: string }): Promise<boolean> {
    if (!isUuid(publicId)) return false;
    const rows = await this.sql`
      update erp.roles set
        name = coalesce(${patch.name ?? null}, name),
        description = case when ${patch.description === undefined} then description else ${patch.description ?? null} end,
        scope_mode = coalesce(${patch.scopeMode ?? null}, scope_mode)
      where organization_id = ${orgId} and public_id = ${publicId}::uuid and deleted_at is null and is_system = false
      returning id
    `;
    return rows.length > 0;
  }

  async deleteRole(orgId: bigint, publicId: string): Promise<boolean> {
    if (!isUuid(publicId)) return false;
    const rows = await this.sql`
      update erp.roles set deleted_at = now()
      where organization_id = ${orgId} and public_id = ${publicId}::uuid and deleted_at is null and is_system = false
      returning id
    `;
    return rows.length > 0;
  }

  async setRolePermissions(orgId: bigint, roleId: bigint, permissionKeys: readonly string[]): Promise<boolean> {
    const rows = await this.sql`
      select id, key from erp.permissions where key = any(${permissionKeys as unknown as string[]})
    `;
    const ids = rows.map((row) => toBigInt(row['id']));
    if (ids.length !== permissionKeys.length) return false;
    await this.sql`delete from erp.role_permissions where role_id = ${roleId}`;
    for (const permissionId of ids) {
      await this.sql`insert into erp.role_permissions (role_id, permission_id) values (${roleId}, ${permissionId}) on conflict do nothing`;
    }
    await this.sql`
      update erp.users set permissions_version = permissions_version + 1
      where id in (select user_id from erp.user_roles where role_id = ${roleId})
    `;
    return true;
  }

  // --- org ----------------------------------------------------------------

  async getOrganization(orgId: bigint): Promise<Record<string, unknown> | null> {
    const rows = await this.sql`
      select public_id, name, legal_name, national_id, economic_code, registration_no,
             base_currency, timezone, fiscal_year_start_month, fiscal_year_start_day,
             valuation_method, allow_negative_stock, status
      from erp.organizations where id = ${orgId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return camelizeRow(row);
  }

  async updateOrganization(orgId: bigint, patch: Record<string, string | number | null>): Promise<void> {
    const allowed = ['name', 'legal_name', 'national_id', 'economic_code', 'registration_no', 'timezone'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        await this.sql`update erp.organizations set ${this.sql(key)} = ${String(patch[key])} where id = ${orgId}`;
      }
    }
  }

  async listBranches(orgId: bigint): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      select public_id, code, name, branch_type, phone, city, province, is_active
      from erp.branches where organization_id = ${orgId} and deleted_at is null order by code
    `;
    return rows.map(camelizeRow);
  }

  async createBranch(orgId: bigint, input: { code: string; name: string; branchType: string; city?: string }): Promise<Record<string, unknown>> {
    const rows = await this.sql`
      insert into erp.branches (organization_id, code, name, branch_type, city)
      values (${orgId}, ${input.code}, ${input.name}, ${input.branchType}, ${input.city ?? null})
      returning public_id, code, name, branch_type, is_active
    `;
    return camelizeRow(rows[0] ?? {});
  }

  async updateBranch(orgId: bigint, publicId: string, patch: { name?: string; isActive?: boolean }): Promise<boolean> {
    if (!isUuid(publicId)) return false;
    const rows = await this.sql`
      update erp.branches set name = coalesce(${patch.name ?? null}, name),
        is_active = coalesce(${patch.isActive ?? null}, is_active)
      where organization_id = ${orgId} and public_id = ${publicId}::uuid returning id
    `;
    return rows.length > 0;
  }

  async listDepartments(orgId: bigint): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      select public_id, code, name, parent_id, is_active from erp.departments
      where organization_id = ${orgId} and deleted_at is null order by code
    `;
    return rows.map(camelizeRow);
  }

  async createDepartment(orgId: bigint, input: { code: string; name: string }): Promise<Record<string, unknown>> {
    const rows = await this.sql`
      insert into erp.departments (organization_id, code, name) values (${orgId}, ${input.code}, ${input.name})
      returning public_id, code, name, is_active
    `;
    return camelizeRow(rows[0] ?? {});
  }

  // --- settings / audit / security -----------------------------------------

  async listSettings(orgId: bigint, group?: string): Promise<Array<Record<string, unknown>>> {
    const prefix = group === undefined ? null : `${group}.%`;
    const rows = await this.sql`
      select key, value_json, is_secret, description_fa from erp.system_settings
      where organization_id = ${orgId} and (${prefix}::text is null or key like ${prefix})
      order by key
    `;
    return rows.map((row) => ({
      key: String(row['key']),
      value: row['is_secret'] === true ? null : row['value_json'],
      isSecret: row['is_secret'] === true,
      descriptionFa: row['description_fa'] === null ? null : String(row['description_fa']),
    }));
  }

  async upsertSetting(orgId: bigint, key: string, value: unknown): Promise<void> {
    await this.sql`
      insert into erp.system_settings (organization_id, key, value_json)
      values (${orgId}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (organization_id, key) do update set value_json = excluded.value_json
    `;
  }

  async listAuditLogs(orgId: bigint, limit: number, afterId?: bigint): Promise<Array<Record<string, unknown>>> {
    const after = afterId ?? 0n;
    const rows = await this.sql`
      select id, actor_user_id, entity_type, entity_public_id, action, request_id, severity, created_at
      from erp.audit_logs
      where organization_id = ${orgId} and id > ${after}
      order by id asc limit ${limit}
    `;
    return rows.map((row) => ({
      id: toBigInt(row['id']).toString(),
      actorId: optionalBigInt(row['actor_user_id'])?.toString() ?? null,
      entityType: String(row['entity_type']),
      entityId: row['entity_public_id'] === null ? null : String(row['entity_public_id']),
      action: String(row['action']),
      requestId: row['request_id'] === null ? null : String(row['request_id']),
      severity: String(row['severity']),
      createdAt: new Date(String(row['created_at'])).toISOString(),
    }));
  }

  async listSecurityEvents(orgId: bigint, limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      select event_type, user_id, ip_address, severity, details, created_at
      from erp.security_events where organization_id = ${orgId}
      order by created_at desc limit ${limit}
    `;
    return rows.map((row) => ({
      type: String(row['event_type']),
      userId: optionalBigInt(row['user_id'])?.toString() ?? null,
      ip: row['ip_address'] === null ? null : String(row['ip_address']),
      severity: String(row['severity']),
      details: row['details'],
      createdAt: new Date(String(row['created_at'])).toISOString(),
    }));
  }
}

function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
    result[camel] = typeof value === 'bigint' ? value.toString() : value;
  }
  return result;
}
