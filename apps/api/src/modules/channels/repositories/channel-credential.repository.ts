/**
 * Encrypted channel credentials. Ciphertext is only read inside an adapter
 * call scope; the API surface returns fingerprints/metadata only.
 */
import type { Db } from '../../../common/contracts';
import { isUniqueViolation, withTransaction } from '../infrastructure/sql';
import { asDate, asNumber, asString } from '../infrastructure/sql';

export const CREDENTIAL_KEY_NAMES = [
  'api_key',
  'api_secret',
  'client_id',
  'client_secret',
  'refresh_token',
  'access_token',
  'webhook_secret',
  'signing_key',
  'basic_user',
  'basic_password',
  'public_key',
  'private_key',
] as const;
export type CredentialKeyName = (typeof CREDENTIAL_KEY_NAMES)[number];

export interface CredentialCipherRow {
  readonly id: string;
  readonly keyName: string;
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly expiresAt: Date | null;
  readonly rotatedAt: Date | null;
  readonly isActive: boolean;
}

export interface CredentialMetadata {
  readonly keyName: string;
  readonly algorithm: 'aes-256-gcm';
  /** `â€¦last4` of the SHA-256 fingerprint â€” never the secret. */
  readonly fingerprintSuffix: string;
  readonly keyVersion: number;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date | null;
}

interface RawCredentialRow {
  id: unknown;
  key_name: unknown;
  ciphertext: unknown;
  key_version: unknown;
  expires_at: unknown;
  rotated_at: unknown;
  is_active: unknown;
}

function mapCredential(row: RawCredentialRow): CredentialCipherRow {
  return {
    id: asString(row.id),
    keyName: asString(row.key_name),
    ciphertext: asString(row.ciphertext),
    keyVersion: asNumber(row.key_version),
    expiresAt: asDate(row.expires_at),
    rotatedAt: asDate(row.rotated_at),
    isActive: row.is_active === true,
  };
}

export interface ChannelCredentialRepositoryPort {
  /** Active, unexpired ciphertext rows for an account. */
  listActive(accountId: string): Promise<readonly CredentialCipherRow[]>;
  /** Active + previous secret still inside the 24 h rotation window. */
  listVerificationSecrets(accountId: string, keyName: CredentialKeyName): Promise<readonly CredentialCipherRow[]>;
  set(input: {
    accountId: string;
    keyName: CredentialKeyName;
    ciphertext: string;
    keyVersion: number;
    actorId: string | null;
  }): Promise<void>;
  deactivate(accountId: string, keyName: CredentialKeyName): Promise<void>;
}

export class SqlChannelCredentialRepository implements ChannelCredentialRepositoryPort {
  constructor(private readonly db: Db) {}

  async listActive(accountId: string): Promise<readonly CredentialCipherRow[]> {
    const rows = await this.db<RawCredentialRow[]>`
      select id, key_name, ciphertext, key_version, expires_at, rotated_at, is_active
      from erp.channel_credentials
      where channel_account_id = ${accountId}::bigint
        and is_active = true
        and (expires_at is null or expires_at > now())
      order by key_name`;
    return rows.map(mapCredential);
  }

  async listVerificationSecrets(
    accountId: string,
    keyName: CredentialKeyName,
  ): Promise<readonly CredentialCipherRow[]> {
    // Rotation keeps the previous row active for 24 h; both are accepted.
    const rows = await this.db<RawCredentialRow[]>`
      select id, key_name, ciphertext, key_version, expires_at, rotated_at, is_active
      from erp.channel_credentials
      where channel_account_id = ${accountId}::bigint
        and key_name = ${keyName}
        and (expires_at is null or expires_at > now())
      order by rotated_at desc nulls last, id desc
      limit 2`;
    return rows.map(mapCredential);
  }

  async set(input: {
    accountId: string;
    keyName: CredentialKeyName;
    ciphertext: string;
    keyVersion: number;
    actorId: string | null;
  }): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      await tx`
        update erp.channel_credentials
        set is_active = false, expires_at = now() + interval '24 hours'
        where channel_account_id = ${input.accountId}::bigint
          and key_name = ${input.keyName}
          and is_active = true`;
      try {
        await tx`
          insert into erp.channel_credentials (
            channel_account_id, key_name, ciphertext, key_version, rotated_at, rotated_by, is_active
          ) values (
            ${input.accountId}::bigint, ${input.keyName}, ${input.ciphertext},
            ${input.keyVersion}, now(), ${input.actorId}::bigint, true
          )`;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Concurrent rotation: keep the newest ciphertext.
          await tx`
            update erp.channel_credentials
            set ciphertext = ${input.ciphertext}, key_version = ${input.keyVersion},
                rotated_at = now(), rotated_by = ${input.actorId}::bigint, is_active = true
            where channel_account_id = ${input.accountId}::bigint
              and key_name = ${input.keyName}
              and is_active = true`;
          return;
        }
        throw error;
      }
    });
  }

  async deactivate(accountId: string, keyName: CredentialKeyName): Promise<void> {
    await this.db`
      update erp.channel_credentials
      set is_active = false, expires_at = now()
      where channel_account_id = ${accountId}::bigint
        and key_name = ${keyName}
        and is_active = true`;
  }
}
