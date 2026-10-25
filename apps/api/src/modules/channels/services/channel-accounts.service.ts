/**
 * Channel account + credential application service.
 *
 * - Secrets are write-only: API responses carry a `…last4` fingerprint only.
 * - Credential writes are audited and decrypt only inside a narrow scope.
 * - Account settings can never override signature headers/algorithm (H-03).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createPublicKey, randomUUID } from 'node:crypto';

import { AppError } from '@saman/shared';
import { AUDIT, CRYPTO, type AuditPort, type CryptoPort, type Db } from '../../../common/contracts';
import { DB } from '../../../common/contracts';
import { IntegrationError } from '../domain/channel.types';
import type { AdapterAccount } from '../domain/channel.types';
import {
  generateRsaKeypair,
  importRsaKeypair,
  publicKeyBase64Der,
  publicKeyFingerprint,
  publicKeyFromPrivate,
  publicKeyPkcs1Pem,
  publicKeySpkiPem,
  RSA_KEY_BITS,
  type RsaKeyBits,
  type RsaKeypair,
} from '../domain/rsa-keypair';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import { AdapterRegistry } from './adapter.registry';
import { type ResolvedAdapterAccount } from './adapter.registry';
import { SqlChannelAccountRepository, type ChannelAccountRow } from '../repositories/channel-account.repository';
import { CREDENTIAL_KEY_NAMES, SqlChannelCredentialRepository, type CredentialKeyName, type CredentialMetadata } from '../repositories/channel-credential.repository';
import { asRecord, asString } from '../infrastructure/sql';

/** Any setting that could weaken webhook verification or redirect egress. */
const FORBIDDEN_SETTING_KEY =
  /(signature|webhook.?secret|secret|header|algorithm|hmac|base.?url|endpoint|token)/i;

export class ChannelSettingsError extends AppError {
  constructor(field: string) {
    super('VALIDATION_ERROR', {
      message: `تنظیم «${field}» قابل تغییر از حساب کانال نیست.`,
      details: [{ field, code: 'immutable_setting' }],
    });
    this.name = 'ChannelSettingsError';
  }
}

export function assertSettingsSafe(settings: Record<string, unknown>, prefix = ''): void {
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (FORBIDDEN_SETTING_KEY.test(key)) throw new ChannelSettingsError(path);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      assertSettingsSafe(value as Record<string, unknown>, path);
    }
  }
}

export function fingerprintSuffix(crypto: CryptoPort, plaintext: string): string {
  if (plaintext.length < 4) return '…';
  return `…${crypto.fingerprint(plaintext).slice(-4)}`;
}

@Injectable()
export class ChannelAccountService {
  private readonly accounts: SqlChannelAccountRepository;
  private readonly credentials: SqlChannelCredentialRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CRYPTO) private readonly crypto: CryptoPort,
    @Inject(LOGGER) private readonly logger: AppLogger,
    private readonly registry: AdapterRegistry,
    @Optional() @Inject(AUDIT) private readonly audit?: AuditPort,
  ) {
    this.accounts = new SqlChannelAccountRepository(db);
    this.credentials = new SqlChannelCredentialRepository(db);
  }

  async get(organizationId: string, accountId: string): Promise<ChannelAccountRow> {
    const row = await this.accounts.findById(organizationId, accountId);
    if (row === null) throw new AppError('NOT_FOUND');
    return row;
  }

  async resolveForSync(
    organizationId: string,
    accountId: string,
  ): Promise<ResolvedAdapterAccount> {
    const row = await this.get(organizationId, accountId);
    const credentials = await this.decryptActive(row.id);
    await this.auditCredentialRead(row, Object.keys(credentials));
    return this.registry.resolve(row, credentials);
  }

  async resolveByPublicId(
    organizationId: string,
    accountPublicId: string,
  ): Promise<ResolvedAdapterAccount> {
    const row = await this.accounts.findByPublicId(organizationId, accountPublicId);
    if (row === null) throw new AppError('NOT_FOUND');
    const credentials = await this.decryptActive(row.id);
    await this.auditCredentialRead(row, Object.keys(credentials));
    return this.registry.resolve(row, credentials);
  }

  /** Credential reads are a `critical` security event (ADR-0008 §5). */
  private async auditCredentialRead(
    row: ChannelAccountRow,
    keyNames: readonly string[],
  ): Promise<void> {
    await this.audit?.record(this.db, {
      action: 'channel.credential.read',
      entityType: 'channel_account',
      entityId: row.id,
      orgId: BigInt(row.organizationId),
      actorId: null,
      requestId: randomUUID(),
      meta: { keys: keyNames },
    });
  }

  /** Decrypted secrets, valid only for the duration of an adapter call. */
  async decryptActive(accountId: string): Promise<Readonly<Record<string, string>>> {
    const rows = await this.credentials.listActive(accountId);
    const result: Record<string, string> = {};
    for (const row of rows) {
      try {
        result[row.keyName] = this.crypto.decrypt(row.ciphertext);
      } catch (error) {
        this.logger.error(
          { accountId, keyName: row.keyName, error: error instanceof Error ? error.message : 'decrypt_failed' },
          'credential decrypt failed',
        );
        throw new AppError('INTERNAL', { message: 'اعتبارنامهٔ کانال قابل خواندن نیست.' });
      }
    }
    return result;
  }

  /**
   * Public half of the stored RSA key-pair. The private key is decrypted only
   * to prove it exists and never leaves the service.
   */
  async rsaKeypair(
    organizationId: string,
    accountId: string,
  ): Promise<{
    publicKeyPem: string;
    publicKeyPkcs1: string;
    publicKeyBase64: string;
    fingerprint: string;
    keyBits: number;
    hasPrivateKey: boolean;
  }> {
    const row = await this.get(organizationId, accountId);
    const credentials = await this.decryptActive(row.id);
    const privateKeyPem = credentials['private_key'];
    let publicKeyPem = credentials['public_key'];
    if (publicKeyPem === undefined && privateKeyPem !== undefined) {
      try {
        publicKeyPem = publicKeyFromPrivate(privateKeyPem);
      } catch {
        publicKeyPem = undefined;
      }
    }
    if (publicKeyPem === undefined) {
      throw new AppError('NOT_FOUND', {
        message: 'کلید RSA برای این حساب ثبت نشده است.',
      });
    }
    return {
      publicKeyPem: publicKeySpkiPem(publicKeyPem),
      publicKeyPkcs1: publicKeyPkcs1Pem(publicKeyPem),
      publicKeyBase64: publicKeyBase64Der(publicKeyPem),
      fingerprint: publicKeyFingerprint(publicKeyPem),
      keyBits: Number(createPublicKey(publicKeyPem).asymmetricKeyDetails?.modulusLength ?? RSA_KEY_BITS),
      hasPrivateKey: privateKeyPem !== undefined,
    };
  }

  /** Generate a fresh pair (2048/4096-bit), or import an existing private key. */
  async setRsaKeypair(input: {
    organizationId: string;
    accountId: string;
    bits?: RsaKeyBits;
    privateKeyPem?: string;
    actorId: string | null;
    requestId: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{
    publicKeyPem: string;
    publicKeyPkcs1: string;
    publicKeyBase64: string;
    fingerprint: string;
    keyBits: number;
  }> {
    const row = await this.get(input.organizationId, input.accountId);
    let keypair: RsaKeypair;
    if (input.privateKeyPem !== undefined && input.privateKeyPem.trim().length > 0) {
      try {
        keypair = importRsaKeypair(input.privateKeyPem.trim());
      } catch {
        throw new AppError('VALIDATION_ERROR', {
          message: 'کلید خصوصی ارسال‌شده معتبر نیست (RSA PEM انتظار می‌رود).',
          details: [{ field: 'privateKeyPem', code: 'invalid_private_key' }],
        });
      }
    } else {
      keypair = generateRsaKeypair(input.bits ?? RSA_KEY_BITS);
    }

    await this.setCredentials({
      organizationId: input.organizationId,
      accountId: row.id,
      credentials: { private_key: keypair.privateKeyPem, public_key: keypair.publicKeyPem },
      actorId: input.actorId,
      requestId: input.requestId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });
    return {
      publicKeyPem: keypair.publicKeyPem,
      publicKeyPkcs1: keypair.publicKeyPkcs1,
      publicKeyBase64: keypair.publicKeyBase64,
      fingerprint: keypair.fingerprint,
      keyBits: keypair.keyBits,
    };
  }

  /**
   * Overwrite the stored pair with a fresh 4096-bit pair. The caller must
   * re-register the new public key in Digikala and request a fresh validation
   * code, because old codes were encrypted with the previous public key.
   */
  async resetRsaKeypair(input: {
    organizationId: string;
    accountId: string;
    actorId: string | null;
    requestId: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ publicKeyPem: string; fingerprint: string; keyBits: number; hasPrivateKey: true; reset: true }> {
    const result = await this.setRsaKeypair(input);
    return { ...result, hasPrivateKey: true, reset: true };
  }

  async credentialMetadata(
    organizationId: string,
    accountId: string,
  ): Promise<readonly CredentialMetadata[]> {
    await this.get(organizationId, accountId);
    const rows = await this.credentials.listActive(accountId);
    return rows.map((row) => {
      let suffix = '…';
      try {
        suffix = fingerprintSuffix(this.crypto, this.crypto.decrypt(row.ciphertext));
      } catch {
        suffix = '…';
      }
      return {
        keyName: row.keyName,
        algorithm: 'aes-256-gcm' as const,
        fingerprintSuffix: suffix,
        keyVersion: row.keyVersion,
        rotatedAt: row.rotatedAt,
        expiresAt: row.expiresAt,
      };
    });
  }

  async setCredentials(input: {
    organizationId: string;
    accountId: string;
    credentials: Readonly<Record<string, string>>;
    actorId: string | null;
    requestId: string;
    ip?: string;
    userAgent?: string;
  }): Promise<readonly CredentialMetadata[]> {
    const row = await this.get(input.organizationId, input.accountId);
    const entries = this.validateCredentialKeys(row, input.credentials);

    for (const [keyName, plaintext] of entries) {
      await this.credentials.set({
        accountId: row.id,
        keyName,
        ciphertext: this.crypto.encrypt(plaintext),
        keyVersion: 1,
        actorId: input.actorId,
      });
    }
    await this.audit?.record(this.db, {
      action: 'channel.credential.write',
      entityType: 'channel_account',
      entityId: row.id,
      orgId: BigInt(row.organizationId),
      actorId: input.actorId === null ? null : BigInt(input.actorId),
      requestId: input.requestId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      meta: { keys: [...entries.keys()], fingerprintOnly: true },
    });
    return this.credentialMetadata(input.organizationId, row.id);
  }

  async rotateCredentials(input: {
    organizationId: string;
    accountId: string;
    credentials: Readonly<Record<string, string>>;
    actorId: string | null;
    requestId: string;
  }): Promise<readonly CredentialMetadata[]> {
    const row = await this.get(input.organizationId, input.accountId);
    const entries = this.validateCredentialKeys(row, input.credentials);

    // Test the new value before invalidating the old one (API.md §4.10).
    const candidate: Record<string, string> = {};
    for (const [keyName] of entries) {
      const active = await this.credentials.listActive(row.id);
      for (const cred of active) candidate[cred.keyName] = this.crypto.decrypt(cred.ciphertext);
      candidate[keyName] = entries.get(keyName) ?? '';
    }
    const resolved = this.registry.resolve(row, candidate);
    await resolved.adapter.authenticate(resolved.account);

    return this.setCredentials(input);
  }

  async removeCredentials(input: {
    organizationId: string;
    accountId: string;
    keyName: CredentialKeyName;
    actorId: string | null;
    requestId: string;
  }): Promise<void> {
    const row = await this.get(input.organizationId, input.accountId);
    await this.credentials.deactivate(row.id, input.keyName);
    await this.audit?.record(this.db, {
      action: 'channel.credential.delete',
      entityType: 'channel_account',
      entityId: row.id,
      orgId: BigInt(row.organizationId),
      actorId: input.actorId === null ? null : BigInt(input.actorId),
      requestId: input.requestId,
      meta: { key: input.keyName },
    });
  }

  /** Secrets used to verify an inbound webhook (active + rotation window). */
  async webhookSecrets(accountId: string): Promise<readonly string[]> {
    const rows = await this.credentials.listVerificationSecrets(accountId, 'webhook_secret');
    const secrets: string[] = [];
    for (const row of rows) {
      try {
        secrets.push(this.crypto.decrypt(row.ciphertext));
      } catch {
        // A corrupt secret must not become an empty secret.
      }
    }
    return secrets;
  }

  async updateSettings(input: {
    organizationId: string;
    accountId: string;
    settings: Record<string, unknown>;
    actorId: string | null;
    requestId: string;
  }): Promise<ChannelAccountRow> {
    assertSettingsSafe(input.settings);
    const row = await this.get(input.organizationId, input.accountId);
    const merged = { ...row.settings, ...input.settings };
    assertSettingsSafe(merged);
    await this.db`
      update erp.channel_accounts
      set settings = ${JSON.stringify(merged)}::jsonb, updated_at = now()
      where organization_id = ${input.organizationId}::bigint and id = ${input.accountId}::bigint`;
    await this.audit?.record(this.db, {
      action: 'channel.account.update',
      entityType: 'channel_account',
      entityId: row.id,
      orgId: BigInt(row.organizationId),
      actorId: input.actorId === null ? null : BigInt(input.actorId),
      requestId: input.requestId,
      before: { settings: Object.keys(row.settings) },
      after: { settings: Object.keys(merged) },
    });
    return this.get(input.organizationId, input.accountId);
  }

  static toAdapterAccount(resolved: ResolvedAdapterAccount): AdapterAccount {
    return resolved.account;
  }

  private validateCredentialKeys(
    row: ChannelAccountRow,
    credentials: Readonly<Record<string, string>>,
  ): Map<CredentialKeyName, string> {
    const entries = new Map<CredentialKeyName, string>();
    for (const [key, value] of Object.entries(credentials)) {
      if (!(CREDENTIAL_KEY_NAMES as readonly string[]).includes(key)) {
        throw new AppError('VALIDATION_ERROR', {
          message: `کلید اعتبارنامهٔ «${key}» مجاز نیست.`,
          details: [{ field: key, code: 'unsupported_credential_key' }],
        });
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new AppError('VALIDATION_ERROR', {
          message: `مقدار اعتبارنامهٔ «${key}» خالی است.`,
          details: [{ field: key, code: 'empty_credential' }],
        });
      }
      entries.set(key as CredentialKeyName, value.trim());
    }
    if (entries.size === 0) {
      throw new AppError('VALIDATION_ERROR', { message: 'هیچ اعتبارنامه‌ای ارسال نشده است.' });
    }
    // RSA key material is standalone: it must not require the channel's
    // primary auth keys in the same request.
    const keyMaterialOnly = [...entries.keys()].every(
      (key) => key === 'private_key' || key === 'public_key',
    );
    if (keyMaterialOnly) return entries;
    // Token activation (Digikala) writes access/refresh tokens that are bound
    // to the already-registered application, not a fresh channel auth. These
    // writes must not demand `api_key` again.
    if (entries.has('access_token') || entries.has('refresh_token')) return entries;
    const required =
      row.authType === 'oauth2_client_credentials'
        ? ['client_id', 'client_secret']
        : ['api_key'];
    for (const key of required) {
      if (!entries.has(key as CredentialKeyName)) {
        throw new AppError('VALIDATION_ERROR', {
          message: `اعتبارنامهٔ «${key}» برای این نوع احراز هویت الزامی است.`,
          details: [{ field: key, code: 'missing_credential' }],
        });
      }
    }
    return entries;
  }
}

export { asRecord, asString };
