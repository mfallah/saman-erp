/** `erp.otp_challenges` persistence (hashed codes, single use). */
import type { Db } from '../../../common/contracts';
import { asDate, asNumber, asString } from '../sms/sms.sql';

export const OTP_PURPOSES = [
  'login',
  'device_trust',
  'password_change',
  'action_confirm',
  'channel_credential',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export interface OtpChallengeRow {
  readonly id: string;
  readonly mobile: string;
  readonly purpose: string;
  readonly codeHash: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date | null;
}

export interface OtpRepositoryPort {
  create(input: {
    organizationId: string | null;
    userId: string | null;
    mobile: string;
    purpose: OtpPurpose;
    codeHash: string;
    provider: string;
    ip: string | null;
    ttlSeconds: number;
    maxAttempts: number;
  }): Promise<string>;
  attachProviderRequest(id: string, providerRequestId: string | null): Promise<void>;
  findById(id: string): Promise<OtpChallengeRow | null>;
  consume(input: { id: string; purpose: OtpPurpose; codeHash: string }): Promise<boolean>;
  registerFailure(id: string): Promise<{ attempts: number; locked: boolean }>;
  invalidate(id: string): Promise<void>;
}

interface RawRow {
  id: unknown;
  mobile: unknown;
  purpose: unknown;
  code_hash: unknown;
  status: unknown;
  attempt_count: unknown;
  max_attempts: unknown;
  expires_at: unknown;
}

function mapRow(row: RawRow): OtpChallengeRow {
  return {
    id: asString(row.id),
    mobile: asString(row.mobile),
    purpose: asString(row.purpose),
    codeHash: asString(row.code_hash),
    status: asString(row.status),
    attemptCount: asNumber(row.attempt_count),
    maxAttempts: asNumber(row.max_attempts),
    expiresAt: asDate(row.expires_at),
  };
}

export class SqlOtpRepository implements OtpRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: {
    organizationId: string | null;
    userId: string | null;
    mobile: string;
    purpose: OtpPurpose;
    codeHash: string;
    provider: string;
    ip: string | null;
    ttlSeconds: number;
    maxAttempts: number;
  }): Promise<string> {
    const rows = await this.db<{ id: string }[]>`
      insert into erp.otp_challenges (
        organization_id, user_id, mobile, purpose, code_hash, provider,
        attempt_count, max_attempts, status, expires_at, ip_address
      ) values (
        ${input.organizationId}::bigint, ${input.userId}::bigint, ${input.mobile},
        ${input.purpose}, ${input.codeHash}, ${input.provider},
        0, ${input.maxAttempts}, 'pending',
        now() + (${input.ttlSeconds}::text || ' seconds')::interval,
        ${input.ip}::inet
      ) returning id::text`;
    const row = rows[0];
    if (row === undefined) throw new Error('otp_create_failed');
    return asString(row.id);
  }

  async attachProviderRequest(id: string, providerRequestId: string | null): Promise<void> {
    await this.db`
      update erp.otp_challenges
      set provider_request_id = ${providerRequestId}
      where id = ${id}::bigint`;
  }

  async findById(id: string): Promise<OtpChallengeRow | null> {
    const rows = await this.db<RawRow[]>`
      select id, mobile, purpose, code_hash, status, attempt_count, max_attempts, expires_at
      from erp.otp_challenges where id = ${id}::bigint`;
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }

  async consume(input: { id: string; purpose: OtpPurpose; codeHash: string }): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      update erp.otp_challenges
      set status = 'consumed', verified_at = now(), consumed_at = now()
      where id = ${input.id}::bigint
        and purpose = ${input.purpose}
        and code_hash = ${input.codeHash}
        and status = 'pending'
        and expires_at > now()
        and attempt_count < max_attempts
      returning id::text`;
    return rows.length > 0;
  }

  async registerFailure(id: string): Promise<{ attempts: number; locked: boolean }> {
    const rows = await this.db<{ attempt_count: unknown; status: unknown }[]>`
      update erp.otp_challenges
      set attempt_count = attempt_count + 1,
          status = case
            when attempt_count + 1 >= max_attempts then 'locked'
            else status
          end
      where id = ${id}::bigint and status = 'pending'
      returning attempt_count, status`;
    const row = rows[0];
    return {
      attempts: row === undefined ? 0 : asNumber(row.attempt_count),
      locked: row !== undefined && asString(row.status) === 'locked',
    };
  }

  async invalidate(id: string): Promise<void> {
    await this.db`
      update erp.otp_challenges
      set status = 'expired'
      where id = ${id}::bigint and status = 'pending'`;
  }
}
