import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, isPermissionKey, type PermissionKey } from '@saman/shared';
import { randomBytes } from 'node:crypto';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { AUDIT, DB, type AuditPort, type Db } from '../../common/contracts';
import type { AuthenticatedActor } from '../../common/auth/authenticated-actor';
import { getAppVersion } from '../../common/version';
// Repositories/services are DI values (constructor metadata), not only types.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { AdminRepository, toBigInt } from './admin.repository';
import { PasswordService } from './password.service';
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { TokenService } from './token.service';

export interface AdminMutationMeta {
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

const SETTINGS_GROUPS = ['general', 'inventory', 'sales', 'purchasing', 'accounting', 'treasury', 'channels', 'security', 'notifications', 'pricing', 'branding'];
const SETTING_KEY = /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

function generatedPassword(): string {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

/** Admin/platform operations with escalation and tenant guards (`ADR-0008`). */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly tokens: TokenService;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    private readonly repository: AdminRepository,
    private readonly passwords: PasswordService,
  ) {
    this.tokens = new TokenService({ secret: config.jwtAccessSecret, accessTtlSeconds: 600 });
  }

  // --- users ---------------------------------------------------------------

  async listUsers(
    actor: AuthenticatedActor,
    query: { search?: string; status?: string; page?: number; perPage?: number; limit?: number },
  ) {
    const perPage = Math.min(query.perPage ?? query.limit ?? 50, 200);
    const page = Math.max(query.page ?? 1, 1);
    const { items, total } = await this.repository.listUsers(actor.orgId, {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: perPage,
      offset: (page - 1) * perPage,
    });
    return {
      items: items.map((row) => ({
        id: row.publicId,
        username: row.username,
        fullName: row.fullName,
        mobile: row.mobile,
        email: row.email,
        status: row.status,
        roles: row.roles,
        mustChangePassword: row.mustChangePassword,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
      })),
      total,
      page,
      perPage,
    };
  }

  async createUser(
    actor: AuthenticatedActor,
    input: { username: string; mobile: string; fullName: string; email?: string; password?: string },
    meta: AdminMutationMeta,
  ) {
    const password = input.password ?? generatedPassword();
    const passwordHash = await this.passwords.hashPassword(password);
    const created = await this.repository.createUser({
      orgId: actor.orgId,
      username: input.username,
      mobile: input.mobile,
      fullName: input.fullName,
      email: input.email ?? null,
      passwordHash,
    });
    await this.auditAction(actor, 'identity.user.created', created.publicId, meta);
    // Never return or log the generated password (ADR-0004).
    return { id: created.publicId, mustChangePassword: true };
  }

  async getUser(actor: AuthenticatedActor, publicId: string) {
    const user = await this.repository.findUserByPublicId(actor.orgId, publicId);
    if (user === null) throw new AppError('NOT_FOUND');
    return { id: user.publicId, permissions: user.permissions };
  }

  async updateUser(
    actor: AuthenticatedActor,
    publicId: string,
    patch: { fullName?: string; email?: string | null; status?: string },
    meta: AdminMutationMeta,
  ) {
    const updated = await this.repository.updateUser(actor.orgId, publicId, patch);
    if (!updated) throw new AppError('NOT_FOUND');
    await this.auditAction(actor, 'identity.user.updated', publicId, meta);
    return this.getUser(actor, publicId);
  }

  async resetPassword(
    actor: AuthenticatedActor,
    publicId: string,
    input: { newPassword?: string; stepUpToken?: string },
    meta: AdminMutationMeta,
  ) {
    this.assertStepUp(actor, input.stepUpToken, 'user.reset_password');
    const password = input.newPassword ?? generatedPassword();
    const violations = this.passwords.validatePolicy(password);
    if (violations.length > 0) {
      throw new AppError('PASSWORD_POLICY_VIOLATION', { details: violations.map((rule) => ({ rule })) });
    }
    const target = await this.repository.findUserByPublicId(actor.orgId, publicId);
    if (target === null) throw new AppError('NOT_FOUND');
    // Target-permission subset check: never reset a more privileged account than the actor.
    if (!target.permissions.every((key) => (actor.permissions as readonly string[]).includes(key))) {
      throw new AppError('FORBIDDEN', { details: [{ rule: 'target_permission_escalation' }] });
    }
    const passwordHash = await this.passwords.hashPassword(password);
    const updated = await this.repository.setUserPassword(actor.orgId, publicId, passwordHash);
    if (!updated) throw new AppError('NOT_FOUND');
    await this.auditAction(actor, 'identity.user.password_reset', publicId, meta);
    return { id: publicId, mustChangePassword: true };
  }

  async setUserRoles(actor: AuthenticatedActor, publicId: string, roleCodes: readonly string[], meta: AdminMutationMeta) {
    const target = await this.repository.findUserByPublicId(actor.orgId, publicId);
    if (target === null) throw new AppError('NOT_FOUND');
    const roles = await this.repository.listRoles(actor.orgId);
    const requested = roles.filter((role) => roleCodes.includes(String(role['code'])));
    if (requested.length !== roleCodes.length) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'roles', rule: 'unknown_role' }] });
    const actorKeys = new Set<string>(actor.permissions);
    for (const role of requested) {
      for (const permission of role['permissions'] as string[]) {
        if (!actorKeys.has(permission)) {
          throw new AppError('FORBIDDEN', { details: [{ rule: 'permission_escalation', params: { permission } }] });
        }
      }
    }
    const updated = await this.repository.setUserRoles(actor.orgId, target.id, roleCodes);
    if (!updated) throw new AppError('VALIDATION_ERROR');
    await this.auditAction(actor, 'identity.user.roles_assigned', publicId, meta);
    return { id: publicId, roles: roleCodes };
  }

  async setUserScope(
    actor: AuthenticatedActor,
    publicId: string,
    input: { branchIds?: readonly string[]; warehouseIds?: readonly string[] },
    meta: AdminMutationMeta,
  ) {
    const target = await this.repository.findUserByPublicId(actor.orgId, publicId);
    if (target === null) throw new AppError('NOT_FOUND');
    const branches = (input.branchIds ?? []).map((id) => toBigInt(id));
    const warehouses = (input.warehouseIds ?? []).map((id) => toBigInt(id));
    await this.repository.setUserScope(actor.orgId, target.id, branches, warehouses);
    await this.auditAction(actor, 'identity.user.scope_assigned', publicId, meta);
    return { id: publicId, branchIds: branches.map(String), warehouseIds: warehouses.map(String) };
  }

  async revokeUserSessions(actor: AuthenticatedActor, publicId: string, meta: AdminMutationMeta) {
    const target = await this.repository.findUserByPublicId(actor.orgId, publicId);
    if (target === null) throw new AppError('NOT_FOUND');
    const revoked = await this.repository.revokeUserSessions(target.id, 'admin');
    await this.auditAction(actor, 'identity.user.sessions_revoked', publicId, meta);
    return { id: publicId, revokedCount: revoked };
  }

  // --- roles ---------------------------------------------------------------

  async listRoles(actor: AuthenticatedActor) {
    return this.repository.listRoles(actor.orgId);
  }

  async createRole(
    actor: AuthenticatedActor,
    input: { code: string; name: string; description?: string; scopeMode?: string },
    meta: AdminMutationMeta,
  ) {
    if (!CODE_PATTERN.test(input.code)) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'code', rule: 'invalid_code' }] });
    const created = await this.repository.createRole(actor.orgId, {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      scopeMode: input.scopeMode ?? 'all',
    });
    await this.auditAction(actor, 'identity.role.created', created.publicId, meta);
    return { id: created.publicId, code: input.code };
  }

  async getRole(actor: AuthenticatedActor, publicId: string) {
    const role = await this.repository.findRole(actor.orgId, publicId);
    if (role === null) throw new AppError('NOT_FOUND');
    return {
      id: publicId,
      code: role.code,
      name: role.name,
      nameFa: role.name,
      descriptionFa: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions,
    };
  }

  async updateRole(
    actor: AuthenticatedActor,
    publicId: string,
    patch: { name?: string; description?: string | null; scopeMode?: string },
    meta: AdminMutationMeta,
  ) {
    const role = await this.repository.findRole(actor.orgId, publicId);
    if (role === null) throw new AppError('NOT_FOUND');
    if (role.isSystem) throw new AppError('FORBIDDEN', { details: [{ rule: 'system_role_immutable' }] });
    const updated = await this.repository.updateRole(actor.orgId, publicId, patch);
    if (!updated) throw new AppError('NOT_FOUND');
    await this.auditAction(actor, 'identity.role.updated', publicId, meta);
    return this.getRole(actor, publicId);
  }

  async deleteRole(actor: AuthenticatedActor, publicId: string, meta: AdminMutationMeta) {
    const role = await this.repository.findRole(actor.orgId, publicId);
    if (role === null) throw new AppError('NOT_FOUND');
    if (role.isSystem) throw new AppError('FORBIDDEN', { details: [{ rule: 'system_role_immutable' }] });
    const deleted = await this.repository.deleteRole(actor.orgId, publicId);
    if (!deleted) throw new AppError('NOT_FOUND');
    await this.auditAction(actor, 'identity.role.deleted', publicId, meta);
    return { id: publicId };
  }

  async setRolePermissions(
    actor: AuthenticatedActor,
    publicId: string,
    permissions: readonly string[],
    meta: AdminMutationMeta,
  ) {
    const role = await this.repository.findRole(actor.orgId, publicId);
    if (role === null) throw new AppError('NOT_FOUND');
    if (role.isSystem) throw new AppError('FORBIDDEN', { details: [{ rule: 'system_role_immutable' }] });
    const actorKeys = new Set<string>(actor.permissions);
    for (const key of permissions) {
      if (!isPermissionKey(key)) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'permissions', rule: 'unknown_permission', params: { key } }] });
      if (!actorKeys.has(key)) throw new AppError('FORBIDDEN', { details: [{ rule: 'permission_escalation', params: { key } }] });
    }
    const updated = await this.repository.setRolePermissions(actor.orgId, role.id, permissions);
    if (!updated) throw new AppError('VALIDATION_ERROR');
    await this.auditAction(actor, 'identity.role.permissions_assigned', publicId, meta);
    return { id: publicId, keys: [...permissions] };
  }

  // --- org / settings / audit ---------------------------------------------

  async organization(actor: AuthenticatedActor) {
    const organization = await this.repository.getOrganization(actor.orgId);
    if (organization === null) throw new AppError('NOT_FOUND');
    return organization;
  }

  async updateOrganization(actor: AuthenticatedActor, patch: Record<string, string | number | null>, meta: AdminMutationMeta) {
    await this.repository.updateOrganization(actor.orgId, patch);
    await this.auditAction(actor, 'org.organization.updated', actor.orgPublicId, meta);
    return this.organization(actor);
  }

  async branches(actor: AuthenticatedActor) {
    const items = await this.repository.listBranches(actor.orgId);
    return { items, total: items.length };
  }

  async createBranch(actor: AuthenticatedActor, input: { code: string; name: string; branchType: string; city?: string }, meta: AdminMutationMeta) {
    const branch = await this.repository.createBranch(actor.orgId, input);
    await this.auditAction(actor, 'org.branch.created', String(branch['id'] ?? ''), meta);
    return branch;
  }

  async updateBranch(actor: AuthenticatedActor, publicId: string, patch: { name?: string; isActive?: boolean }, meta: AdminMutationMeta) {
    const updated = await this.repository.updateBranch(actor.orgId, publicId, patch);
    if (!updated) throw new AppError('NOT_FOUND');
    await this.auditAction(actor, 'org.branch.updated', publicId, meta);
    return { id: publicId };
  }

  async departments(actor: AuthenticatedActor) {
    const items = await this.repository.listDepartments(actor.orgId);
    return { items, total: items.length };
  }

  async createDepartment(actor: AuthenticatedActor, input: { code: string; name: string }, meta: AdminMutationMeta) {
    const department = await this.repository.createDepartment(actor.orgId, input);
    await this.auditAction(actor, 'org.department.created', String(department['id'] ?? ''), meta);
    return department;
  }

  async settings(actor: AuthenticatedActor, group?: string): Promise<{ items: Array<Record<string, unknown>> } | Record<string, unknown>> {
    if (group !== undefined && !SETTINGS_GROUPS.includes(group)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'group', rule: 'unknown_settings_group' }] });
    }
    const rows = await this.repository.listSettings(actor.orgId, group);
    if (group === undefined) return { items: rows };
    // One group is a flat `{ key: value }` map so the settings UI can bind directly.
    const flat: Record<string, unknown> = {};
    for (const row of rows) flat[String(row['key'])] = row['value'];
    return flat;
  }

  async updateSettings(actor: AuthenticatedActor, group: string, values: Record<string, unknown>, meta: AdminMutationMeta) {
    if (!SETTINGS_GROUPS.includes(group)) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'group', rule: 'unknown_settings_group' }] });
    for (const [key, value] of Object.entries(values)) {
      if (!SETTING_KEY.test(key) || !key.startsWith(`${group}.`)) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: key, rule: 'unknown_setting_key' }] });
      }
      if (/secret|password|token|key/i.test(key)) {
        throw new AppError('FORBIDDEN', { details: [{ field: key, rule: 'secret_setting_not_api_writable' }] });
      }
      await this.repository.upsertSetting(actor.orgId, key, value);
    }
    await this.auditAction(actor, 'platform.settings.updated', group, meta);
    return this.settings(actor, group);
  }

  systemInfo() {
    const version = getAppVersion();
    return {
      name: version.name,
      version: version.version,
      env: this.config.appEnv,
      commit: this.config.gitSha,
      smsMode: this.config.smsMode,
      docsEnabled: this.config.docsEnabled,
    };
  }

  async auditLogs(actor: AuthenticatedActor, query: { limit?: number; cursor?: string }) {
    const limit = Math.min(query.limit ?? 50, 200);
    const after = query.cursor !== undefined && /^\d+$/.test(query.cursor) ? BigInt(query.cursor) : undefined;
    const items = await this.repository.listAuditLogs(actor.orgId, limit, after);
    return { items, nextCursor: items.length === limit ? String(items[items.length - 1]?.['id']) : null };
  }

  async securityEvents(actor: AuthenticatedActor, limit = 50) {
    return { items: await this.repository.listSecurityEvents(actor.orgId, Math.min(limit, 200)) };
  }

  // --- internals -----------------------------------------------------------

  private assertStepUp(actor: AuthenticatedActor, token: string | undefined, action: string): void {
    if (token === undefined || token === '') throw new AppError('STEP_UP_REQUIRED');
    const claims = this.tokens.verifyStepUpToken(token);
    if (claims.sid !== actor.sessionPublicId || claims.act !== action) {
      throw new AppError('STEP_UP_REQUIRED');
    }
  }

  private async auditAction(actor: AuthenticatedActor, action: string, entityId: string, meta: AdminMutationMeta): Promise<void> {
    try {
      await this.audit.record(this.db, {
        action,
        entityType: action.startsWith('org.') ? 'org' : 'identity',
        entityId: entityPublicId(entityId),
        orgId: actor.orgId,
        actorId: actor.id,
        requestId: meta.requestId,
        after: { requestId: meta.requestId },
      });
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : 'audit_failed' }, 'admin_audit_write_failed');
    }
  }
}

function entityPublicId(value: string): string | bigint {
  if (/^\d+$/.test(value)) return BigInt(value);
  return value;
}

// Re-exported for controller typing convenience.
export type { PermissionKey };
