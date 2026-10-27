import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';

import { DB, type Db } from '../../common/contracts';
import type { IdentityUserRecord, OtpPurpose } from './identity.types';

/** postgres.js client typed for parametrised queries (the contracts `Db` alias types params as never). */
export type SqlClient = Sql<Record<string, unknown>>;

export interface SessionRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly familyId: string;
  readonly userId: bigint;
  readonly refreshTokenHash: string;
  readonly deviceId: bigint | null;
  readonly mfaVerified: boolean;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly ip: string | null;
  readonly userAgentHash: string | null;
  readonly lastUsedAt: Date | null;
}

export interface DeviceRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly fingerprintHash: string;
  readonly secretHash: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly trusted: boolean;
  readonly trustedUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date | null;
}

export interface OtpChallengeRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly userId: bigint | null;
  readonly mobile: string;
  readonly purpose: OtpPurpose;
  readonly codeHash: string;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface ActorAccessRecord {
  readonly permissionKeys: string[];
  readonly roleCodes: string[];
  readonly branchIds: bigint[] | null;
  readonly warehouseIds: bigint[] | null;
}

export interface SessionRowView {
  readonly publicId: string;
  readonly deviceLabel: string | null;
  readonly ipPrefix: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly current: boolean;
}

export interface DeviceRowView {
  readonly publicId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly trusted: boolean;
  readonly trustedUntil: Date | null;
  readonly lastSeenAt: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && value.length > 0) return BigInt(value);
  throw new RangeError('expected bigint value');
}

export function toOptionalBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return toBigInt(value);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toOptionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

function asSql(tx: Db): SqlClient {
  return tx as unknown as SqlClient;
}

/**
 * Tenant-scoped SQL for the identity module (`DATA-MODEL.md` §2.2).
 * Repositories own SQL; services own rules (`ARCHITECTURE.md` §5).
 */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private get sql(): SqlClient {
    return asSql(this.db);
  }

  async loadOrganization(client?: SqlClient): Promise<{ id: bigint; publicId: string }> {
    const sql = client ?? this.sql;
    const rows = await sql`
      select id, public_id from erp.organizations
      where status <> 'archived' order by id asc limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('organization_missing: run db:seed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async findUserByLogin(orgId: bigint, login: string): Promise<IdentityUserRecord | null> {
    const rows = await this.sql`
      select id, public_id, organization_id, username, mobile, full_name, email, password_hash,
             status, must_change_password, permissions_version, mfa_enabled, failed_login_count,
             locked_until, locale, last_login_at
      from erp.users
      where organization_id = ${orgId}
        and deleted_at is null
        and (lower(username) = lower(${login}) or mobile = ${login})
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapUser(row);
  }

  async findUserById(userId: bigint, client?: SqlClient): Promise<IdentityUserRecord | null> {
    const sql = client ?? this.sql;
    const rows = await sql`
      select id, public_id, organization_id, username, mobile, full_name, email, password_hash,
             status, must_change_password, permissions_version, mfa_enabled, failed_login_count,
             locked_until, locale, last_login_at
      from erp.users where id = ${userId} and deleted_at is null limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapUser(row);
  }

  async findUserByPublicId(publicId: string): Promise<IdentityUserRecord | null> {
    if (!UUID_PATTERN.test(publicId)) return null;
    const rows = await this.sql`
      select id, public_id, organization_id, username, mobile, full_name, email, password_hash,
             status, must_change_password, permissions_version, mfa_enabled, failed_login_count,
             locked_until, locale, last_login_at
      from erp.users where public_id = ${publicId}::uuid and deleted_at is null limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapUser(row);
  }

  async findSessionByPublicId(publicId: string): Promise<SessionRecord | null> {
    if (!UUID_PATTERN.test(publicId)) return null;
    const rows = await this.sql`
      select id, public_id, session_family_id, user_id, refresh_token_hash, device_id,
             mfa_verified, expires_at, revoked_at, ip_prefix, user_agent_hash, last_used_at
      from erp.auth_sessions where public_id = ${publicId}::uuid limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapSession(row);
  }

  async touchSessionLastUsed(sessionId: bigint): Promise<void> {
    await this.sql`update erp.auth_sessions set last_used_at = now() where id = ${sessionId}`;
  }

  /** Effective permissions + roles + scope narrowing for a user. */
  async loadAccess(userId: bigint, client?: SqlClient): Promise<ActorAccessRecord> {
    const sql = client ?? this.sql;
    const permissionRows = await sql`
      select distinct p.key as key
      from erp.user_roles ur
      join erp.role_permissions rp on rp.role_id = ur.role_id
      join erp.permissions p on p.id = rp.permission_id
      where ur.user_id = ${userId}
        and (ur.expires_at is null or ur.expires_at > now())
      order by 1
    `;
    const roleRows = await sql`
      select distinct r.code as code
      from erp.user_roles ur join erp.roles r on r.id = ur.role_id
      where ur.user_id = ${userId} and (ur.expires_at is null or ur.expires_at > now())
      order by 1
    `;
    const scopeRows = await sql`
      select scope_type, scope_id, organization_id from erp.user_scopes where user_id = ${userId}
    `;
    const permissionKeys = permissionRows
      .map((row) => row['key'])
      .filter((key): key is string => typeof key === 'string');
    const roleCodes = roleRows
      .map((row) => row['code'])
      .filter((code): code is string => typeof code === 'string');
    let branchIds: bigint[] | null = null;
    let warehouseIds: bigint[] | null = null;
    for (const row of scopeRows) {
      const scopeType = String(row['scope_type']);
      const scopeId = toBigInt(row['scope_id']);
      if (scopeType === 'branch') branchIds = [...(branchIds ?? []), scopeId];
      if (scopeType === 'warehouse') warehouseIds = [...(warehouseIds ?? []), scopeId];
    }
    return { permissionKeys, roleCodes, branchIds, warehouseIds };
  }

  async registerFailedLogin(
    userId: bigint,
    maxFailed: number,
    lockMinutes: number,
  ): Promise<{ failedCount: number; lockedUntil: Date | null }> {
    const rows = await this.sql`
      update erp.users
      set failed_login_count = failed_login_count + 1,
          locked_until = case
            when failed_login_count + 1 >= ${maxFailed}
            then now() + (${lockMinutes} * interval '1 minute')
            else locked_until
          end,
          status = case
            when failed_login_count + 1 >= ${maxFailed} then 'locked'
            else status
          end
      where id = ${userId}
      returning failed_login_count, locked_until
    `;
    const row = rows[0];
    if (row === undefined) return { failedCount: 0, lockedUntil: null };
    return {
      failedCount: Number(row['failed_login_count']),
      lockedUntil: toOptionalDate(row['locked_until']),
    };
  }

  async registerSuccessfulLogin(userId: bigint): Promise<void> {
    await this.sql`
      update erp.users
      set failed_login_count = 0, locked_until = null,
          status = case when status = 'locked' then 'active' else status end,
          last_login_at = now()
      where id = ${userId}
    `;
  }

  async createSession(input: {
    userId: bigint;
    refreshTokenHash: string;
    familyId?: string;
    deviceId: bigint | null;
    ipPrefix: string | null;
    userAgentHash: string | null;
    mfaVerified: boolean;
    expiresAt: Date;
    absoluteExpiresAt: Date;
  }, client?: SqlClient): Promise<{ id: bigint; publicId: string; familyId: string }> {
    const familyId = input.familyId ?? randomUUID();
    const sql = client ?? this.sql;
    const rows = await sql`
      insert into erp.auth_sessions (
        user_id, session_family_id, refresh_token_hash, device_id, ip_prefix, user_agent_hash,
        mfa_verified, expires_at, absolute_expires_at
      ) values (
        ${input.userId}, ${familyId}::uuid, ${input.refreshTokenHash}, ${input.deviceId},
        ${input.ipPrefix}, ${input.userAgentHash}, ${input.mfaVerified},
        ${input.expiresAt}, ${input.absoluteExpiresAt}
      )
      returning id, public_id, session_family_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('session_insert_failed');
    return {
      id: toBigInt(row['id']),
      publicId: String(row['public_id']),
      familyId: String(row['session_family_id']),
    };
  }

  async findSessionByRefreshHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.sql`
      select id, public_id, session_family_id, user_id, refresh_token_hash, device_id,
             mfa_verified, expires_at, revoked_at, ip_prefix, user_agent_hash, last_used_at
      from erp.auth_sessions where refresh_token_hash = ${refreshTokenHash} limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapSession(row);
  }

  async rotateSession(
    previous: {
      id: bigint;
      userId: bigint;
      familyId: string;
      deviceId: bigint | null;
      mfaVerified: boolean;
      ip: string | null;
      userAgentHash: string | null;
    },
    next: { refreshTokenHash: string; expiresAt: Date; absoluteExpiresAt: Date },
  ): Promise<{ id: bigint; publicId: string }> {
    const rows = await this.sql`
      insert into erp.auth_sessions (
        user_id, session_family_id, refresh_token_hash, device_id, ip_prefix, user_agent_hash,
        mfa_verified, expires_at, absolute_expires_at
      ) values (
        ${previous.userId}, ${previous.familyId}, ${next.refreshTokenHash}, ${previous.deviceId},
        ${previous.ip}, ${previous.userAgentHash}, ${previous.mfaVerified},
        ${next.expiresAt}, ${next.absoluteExpiresAt}
      ) returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('session_rotate_failed');
    await this.sql`
      update erp.auth_sessions
      set revoked_at = now(), revoke_reason = 'rotated', replaced_by_session_id = ${toBigInt(row['id'])}
      where id = ${previous.id} and revoked_at is null
    `;
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    if (!UUID_PATTERN.test(familyId)) return;
    await this.sql`
      update erp.auth_sessions
      set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, ${reason})
      where session_family_id = ${familyId}::uuid and revoked_at is null
    `;
  }

  async revokeSessionById(sessionId: bigint, reason: string): Promise<void> {
    await this.sql`
      update erp.auth_sessions
      set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, ${reason})
      where id = ${sessionId}
    `;
  }

  async revokeSessionByPublicId(userId: bigint, publicId: string): Promise<number> {
    if (!UUID_PATTERN.test(publicId)) return 0;
    const rows = await this.sql`
      update erp.auth_sessions
      set revoked_at = now(), revoke_reason = 'admin'
      where user_id = ${userId} and public_id = ${publicId}::uuid and revoked_at is null
      returning id
    `;
    return rows.length;
  }

  async revokeOtherSessions(userId: bigint, keepSessionId: bigint, reason: string): Promise<number> {
    const rows = await this.sql`
      update erp.auth_sessions
      set revoked_at = now(), revoke_reason = ${reason}
      where user_id = ${userId} and id <> ${keepSessionId} and revoked_at is null
      returning id
    `;
    return rows.length;
  }

  async revokeAllSessions(userId: bigint, reason: string): Promise<number> {
    const rows = await this.sql`
      update erp.auth_sessions
      set revoked_at = now(), revoke_reason = ${reason}
      where user_id = ${userId} and revoked_at is null
      returning id
    `;
    return rows.length;
  }

  async listSessions(userId: bigint, currentSessionId: bigint): Promise<SessionRowView[]> {
    const rows = await this.sql`
      select s.public_id, s.ip_prefix, s.created_at, s.last_used_at, s.revoked_at,
             d.label as device_label, (s.id = ${currentSessionId}) as is_current
      from erp.auth_sessions s left join erp.user_devices d on d.id = s.device_id
      where s.user_id = ${userId}
      order by s.created_at desc limit 100
    `;
    return rows.map((row) => ({
      publicId: String(row['public_id']),
      deviceLabel: row['device_label'] === null ? null : String(row['device_label']),
      ipPrefix: row['ip_prefix'] === null ? null : String(row['ip_prefix']),
      createdAt: toDate(row['created_at']),
      lastUsedAt: toOptionalDate(row['last_used_at']),
      revokedAt: toOptionalDate(row['revoked_at']),
      current: row['is_current'] === true,
    }));
  }

  async findDeviceByIdentity(userId: bigint, fingerprintHash: string): Promise<DeviceRecord | null> {
    const rows = await this.sql`
      select id, public_id, device_fingerprint_hash, device_secret_hash, label, platform,
             trusted, trusted_until, revoked_at, last_seen_at
      from erp.user_devices
      where user_id = ${userId} and device_fingerprint_hash = ${fingerprintHash}
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapDevice(row);
  }

  async upsertDevice(input: {
    userId: bigint;
    fingerprintHash: string;
    secretHash: string;
    label: string | null;
    platform: string | null;
    userAgentHash: string | null;
    trusted: boolean;
    trustedUntil: Date | null;
  }, client?: SqlClient): Promise<{ id: bigint; publicId: string }> {
    const sql = client ?? this.sql;
    const rows = await sql`
      insert into erp.user_devices (
        user_id, device_fingerprint_hash, device_secret_hash, label, platform,
        user_agent_hash, trusted, trusted_until, last_seen_at
      ) values (
        ${input.userId}, ${input.fingerprintHash}, ${input.secretHash}, ${input.label},
        ${input.platform}, ${input.userAgentHash}, ${input.trusted}, ${input.trustedUntil}, now()
      )
      on conflict (user_id, device_fingerprint_hash) do update set
        device_secret_hash = excluded.device_secret_hash,
        secret_issued_at = now(),
        label = excluded.label,
        platform = excluded.platform,
        trusted = excluded.trusted,
        trusted_until = excluded.trusted_until,
        last_seen_at = now(),
        revoked_at = null
      returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('device_upsert_failed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async touchDevice(deviceId: bigint): Promise<void> {
    await this.sql`update erp.user_devices set last_seen_at = now() where id = ${deviceId}`;
  }

  async listDevices(userId: bigint): Promise<DeviceRowView[]> {
    const rows = await this.sql`
      select public_id, label, platform, trusted, trusted_until, last_seen_at
      from erp.user_devices where user_id = ${userId} and revoked_at is null
      order by last_seen_at desc nulls last limit 100
    `;
    return rows.map((row) => ({
      publicId: String(row['public_id']),
      label: row['label'] === null ? null : String(row['label']),
      platform: row['platform'] === null ? null : String(row['platform']),
      trusted: row['trusted'] === true,
      trustedUntil: toOptionalDate(row['trusted_until']),
      lastSeenAt: toOptionalDate(row['last_seen_at']),
    }));
  }

  async trustDevice(
    userId: bigint,
    devicePublicId: string,
    secretHash: string,
    trustedUntil: Date,
  ): Promise<boolean> {
    if (!UUID_PATTERN.test(devicePublicId)) return false;
    const rows = await this.sql`
      update erp.user_devices
      set trusted = true, trusted_until = ${trustedUntil}, device_secret_hash = ${secretHash},
          secret_issued_at = now(), revoked_at = null
      where user_id = ${userId} and public_id = ${devicePublicId}::uuid
      returning id
    `;
    return rows.length > 0;
  }

  async revokeDevice(userId: bigint, devicePublicId: string): Promise<number> {
    if (!UUID_PATTERN.test(devicePublicId)) return 0;
    const rows = await this.sql`
      update erp.user_devices
      set revoked_at = now(), trusted = false, trusted_until = null
      where user_id = ${userId} and public_id = ${devicePublicId}::uuid and revoked_at is null
      returning id
    `;
    return rows.length;
  }

  async revokeAllDevices(userId: bigint, keepDeviceId: bigint | null): Promise<number> {
    const rows =
      keepDeviceId === null
        ? await this.sql`
            update erp.user_devices set revoked_at = now(), trusted = false, trusted_until = null
            where user_id = ${userId} and revoked_at is null returning id`
        : await this.sql`
            update erp.user_devices set revoked_at = now(), trusted = false, trusted_until = null
            where user_id = ${userId} and revoked_at is null and id <> ${keepDeviceId} returning id`;
    return rows.length;
  }

  async createOtpChallenge(input: {
    organizationId: bigint | null;
    userId: bigint | null;
    mobile: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
    maxAttempts: number;
    ip: string | null;
  }): Promise<{ id: bigint; publicId: string }> {
    const rows = await this.sql`
      insert into erp.otp_challenges (
        organization_id, user_id, mobile, purpose, code_hash, expires_at, max_attempts, ip_address
      ) values (
        ${input.organizationId}, ${input.userId}, ${input.mobile}, ${input.purpose},
        ${input.codeHash}, ${input.expiresAt}, ${input.maxAttempts}, ${input.ip}
      ) returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('otp_insert_failed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  async findOtpChallenge(publicId: string, client?: SqlClient): Promise<OtpChallengeRecord | null> {
    if (!UUID_PATTERN.test(publicId)) return null;
    const sql = client ?? this.sql;
    const rows = await sql`
      select id, public_id, user_id, mobile, purpose, code_hash, status, attempt_count,
             max_attempts, expires_at, consumed_at
      from erp.otp_challenges where public_id = ${publicId}::uuid limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: toBigInt(row['id']),
      publicId: String(row['public_id']),
      userId: toOptionalBigInt(row['user_id']),
      mobile: String(row['mobile']),
      purpose: String(row['purpose']) as OtpPurpose,
      codeHash: String(row['code_hash']),
      status: String(row['status']),
      attempts: Number(row['attempt_count']),
      maxAttempts: Number(row['max_attempts']),
      expiresAt: toDate(row['expires_at']),
      consumedAt: toOptionalDate(row['consumed_at']),
    };
  }

  /**
   * TD-15: verification and single-use consumption are ONE atomic statement.
   *
   * `UPDATE … SET consumed_at = now(), attempt_count = attempt_count + 1
   *  WHERE public_id = $1 AND consumed_at IS NULL AND expires_at > now()
   *    AND code_hash = $2 AND status IN ('pending','verified')
   *  RETURNING id`
   *
   * Postgres serialises concurrent updates of the same row: the first commit
   * sees `consumed_at IS NULL` and wins; every concurrent waiter re-evaluates
   * the predicate against the new row version, sees `consumed_at` set, and
   * returns zero rows. The caller creates a session only when exactly one row
   * comes back, so a replayed/losing verify can never mint a second session.
   * The `attempt_count < max_attempts` guard keeps lockout unbypassable.
   */
  async consumeOtpChallenge(input: {
    publicId: string;
    codeHash: string;
    maxAttempts: number;
    client?: SqlClient;
  }): Promise<boolean> {
    if (!UUID_PATTERN.test(input.publicId)) return false;
    const sql = input.client ?? this.sql;
    const rows = await sql`
      update erp.otp_challenges
         set consumed_at = now(),
             verified_at = coalesce(verified_at, now()),
             status = 'consumed',
             attempt_count = attempt_count + 1
       where public_id = ${input.publicId}::uuid
         and consumed_at is null
         and expires_at > now()
         and code_hash = ${input.codeHash}
         and status in ('pending', 'verified')
         and attempt_count < ${input.maxAttempts}
      returning id
    `;
    return rows.length === 1;
  }

  /**
   * Failed-verification counter, also a single guarded statement: it only
   * increments while the challenge is unconsumed, unexpired and under its
   * attempt budget, so a replay of a consumed challenge cannot move the
   * counter and a race cannot exceed `max_attempts`.
   */
  async registerFailedOtpAttempt(input: {
    publicId: string;
    maxAttempts: number;
    client?: SqlClient;
  }): Promise<{ attempts: number; maxAttempts: number } | null> {
    if (!UUID_PATTERN.test(input.publicId)) return null;
    const sql = input.client ?? this.sql;
    const rows = await sql`
      update erp.otp_challenges
         set attempt_count = attempt_count + 1
       where public_id = ${input.publicId}::uuid
         and consumed_at is null
         and expires_at > now()
         and attempt_count < ${input.maxAttempts}
      returning attempt_count, max_attempts
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      attempts: Number(row['attempt_count']),
      maxAttempts: Number(row['max_attempts']),
    };
  }

  async updateOtpChallenge(
    challengeId: bigint,
    input: { status?: string; codeHash?: string; expiresAt?: Date; consumed?: boolean },
  ): Promise<void> {
    await this.sql`
      update erp.otp_challenges set
        status = coalesce(${input.status ?? null}, status),
        code_hash = coalesce(${input.codeHash ?? null}, code_hash),
        expires_at = coalesce(${input.expiresAt ?? null}, expires_at),
        verified_at = case when ${input.status === 'verified'} then now() else verified_at end,
        consumed_at = case when ${input.consumed === true} then now() else consumed_at end
      where id = ${challengeId}
    `;
  }

  async recordLoginAttempt(input: {
    ipPrefix: string | null;
    username: string | null;
    mobile: string | null;
    userId: bigint | null;
    attemptType: 'password' | 'otp_send' | 'otp_verify' | 'refresh';
    success: boolean;
    failureReason: string | null;
    userAgentHash: string | null;
  }): Promise<void> {
    await this.sql`
      insert into erp.login_attempts (
        ip_prefix, username, mobile, user_id, attempt_type, success, failure_reason, user_agent_hash
      ) values (
        ${input.ipPrefix}, ${input.username}, ${input.mobile}, ${input.userId}, ${input.attemptType},
        ${input.success}, ${input.failureReason}, ${input.userAgentHash}
      )
    `;
  }

  async recordSecurityEvent(input: {
    organizationId: bigint | null;
    eventType: string;
    userId: bigint | null;
    sessionId: bigint | null;
    ip: string | null;
    userAgentHash: string | null;
    details: Record<string, unknown>;
    severity: 'info' | 'warning' | 'critical';
  }): Promise<void> {
    await this.sql`
      insert into erp.security_events (
        organization_id, event_type, user_id, session_id, ip_address, user_agent_hash, details, severity
      ) values (
        ${input.organizationId}, ${input.eventType}, ${input.userId}, ${input.sessionId},
        ${input.ip}, ${input.userAgentHash}, ${JSON.stringify(input.details)}::jsonb, ${input.severity}
      )
    `;
  }

  async listSecurityEvents(userId: bigint, limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      select public_id, event_type, severity, details, created_at
      from erp.security_events where user_id = ${userId}
      order by created_at desc limit ${limit}
    `;
    return rows.map((row) => ({
      id: String(row['public_id']),
      type: String(row['event_type']),
      severity: String(row['severity']),
      details: row['details'],
      createdAt: toDate(row['created_at']).toISOString(),
    }));
  }

  async loadPasswordHistory(userId: bigint, limit: number): Promise<string[]> {
    const rows = await this.sql`
      select password_hash from erp.password_history
      where user_id = ${userId} order by created_at desc limit ${limit}
    `;
    return rows
      .map((row) => row['password_hash'])
      .filter((hashValue): hashValue is string => typeof hashValue === 'string');
  }

  async updatePassword(userId: bigint, passwordHash: string, mustChangePassword: boolean): Promise<void> {
    await this.sql`
      update erp.users set password_hash = ${passwordHash}, password_changed_at = now(),
        must_change_password = ${mustChangePassword},
        permissions_version = permissions_version + 1,
        status = case when status = 'password_reset_required' then 'active' else status end
      where id = ${userId}
    `;
    await this.sql`
      insert into erp.password_history (user_id, password_hash) values (${userId}, ${passwordHash})
    `;
  }

  async findRoleByCode(organizationId: bigint, code: string): Promise<{ id: bigint } | null> {
    const rows = await this.sql`
      select id from erp.roles where organization_id = ${organizationId} and code = ${code} limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : { id: toBigInt(row['id']) };
  }

  async assignRole(userId: bigint, roleId: bigint): Promise<void> {
    await this.sql`
      insert into erp.user_roles (user_id, role_id) values (${userId}, ${roleId})
      on conflict (user_id, role_id) do nothing
    `;
  }

  async countActiveUsers(organizationId: bigint): Promise<number> {
    const rows = await this.sql`
      select count(*)::int as count from erp.users
      where organization_id = ${organizationId} and deleted_at is null
    `;
    const row = rows[0];
    return row === undefined ? 0 : Number(row['count']);
  }

  async createUser(input: {
    organizationId: bigint;
    username: string;
    mobile: string;
    fullName: string;
    passwordHash: string;
    mustChangePassword: boolean;
  }): Promise<{ id: bigint; publicId: string }> {
    const rows = await this.sql`
      insert into erp.users (
        organization_id, username, mobile, full_name, password_hash, status,
        must_change_password, mfa_enabled, locale
      ) values (
        ${input.organizationId}, ${input.username}, ${input.mobile}, ${input.fullName},
        ${input.passwordHash}, 'active', ${input.mustChangePassword}, false, 'fa-IR'
      ) returning id, public_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('user_insert_failed');
    return { id: toBigInt(row['id']), publicId: String(row['public_id']) };
  }

  findBootstrapRole(organizationId: bigint): Promise<{ id: bigint } | null> {
    return this.findRoleByCode(organizationId, 'superadmin');
  }
}

function mapUser(row: Record<string, unknown>): IdentityUserRecord {
  return {
    id: toBigInt(row['id']),
    publicId: String(row['public_id']),
    organizationId: toBigInt(row['organization_id']),
    username: String(row['username']),
    mobile: String(row['mobile']),
    fullName: String(row['full_name']),
    email: row['email'] === null ? null : String(row['email']),
    passwordHash: row['password_hash'] === null ? null : String(row['password_hash']),
    status: String(row['status']) as IdentityUserRecord['status'],
    mustChangePassword: row['must_change_password'] === true,
    permissionsVersion: Number(row['permissions_version']),
    mfaEnabled: row['mfa_enabled'] === true,
    failedLoginCount: Number(row['failed_login_count']),
    lockedUntil: toOptionalDate(row['locked_until']),
    locale: String(row['locale']),
    lastLoginAt: toOptionalDate(row['last_login_at']),
  };
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: toBigInt(row['id']),
    publicId: String(row['public_id']),
    familyId: String(row['session_family_id']),
    userId: toBigInt(row['user_id']),
    refreshTokenHash: String(row['refresh_token_hash']),
    deviceId: toOptionalBigInt(row['device_id']),
    mfaVerified: row['mfa_verified'] === true,
    expiresAt: toDate(row['expires_at']),
    revokedAt: toOptionalDate(row['revoked_at']),
    ip: row['ip_prefix'] === null ? null : String(row['ip_prefix']),
    userAgentHash: row['user_agent_hash'] === null ? null : String(row['user_agent_hash']),
    lastUsedAt: toOptionalDate(row['last_used_at']),
  };
}

function mapDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    id: toBigInt(row['id']),
    publicId: String(row['public_id']),
    fingerprintHash: String(row['device_fingerprint_hash']),
    secretHash: String(row['device_secret_hash']),
    label: row['label'] === null ? null : String(row['label']),
    platform: row['platform'] === null ? null : String(row['platform']),
    trusted: row['trusted'] === true,
    trustedUntil: toOptionalDate(row['trusted_until']),
    revokedAt: toOptionalDate(row['revoked_at']),
    lastSeenAt: toOptionalDate(row['last_seen_at']),
  };
}
