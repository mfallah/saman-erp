/**
 * Channel administration API: channels, seller accounts, encrypted credentials,
 * connection test and sync jobs. The SPA already called these paths, but no
 * controller existed, so every channel screen returned `NOT_FOUND`.
 */
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppError } from '@saman/shared';

import { DB, type Db } from '../../../common/contracts';
import type { TenantContext } from '../../../common/contracts';
import { CurrentTenant } from '../../../common/decorators/current-context.decorator';
import { Permissions } from '../../..//common/decorators/permissions.decorator';
import { apiData } from '../../../common/interceptors/response.interceptor';
import { ChannelAccountService } from '../services/channel-accounts.service';
import {
  normalizePublicKey,
  publicKeyFingerprint,
  publicKeyFromPrivate,
  type RsaKeyBits,
} from '../domain/rsa-keypair';
import {
  activateDigikalaToken,
  decryptValidationCode,
  RsaDecryptionError,
} from '../adapters/digikala/digikala-activation.service';
import {
  ChannelSyncService,
  SYNC_TRIGGER_TYPES,
  type SyncTriggerType,
} from '../services/channel-sync.service';
import { CREDENTIAL_KEY_NAMES, type CredentialKeyName } from '../repositories/channel-credential.repository';
import { asRecord } from '../infrastructure/sql';

type Row = Record<string, unknown>;
type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

const ALLOWED_KEYS = new Set<string>(CREDENTIAL_KEY_NAMES);

/** Stable counters exposed to the SPA regardless of which job produced them. */
interface SyncJobSummary {
  readonly imported: number;
  readonly updated: number;
  readonly failed: number;
  readonly pushed: number;
  readonly skipped: number;
  readonly error: string | null;
}

function summaryCount(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  // postgres.js/PgBouncer may surface numeric counters as strings.
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

/**
 * Normalises `channel_sync_jobs.response_summary` (jsonb, sometimes a JSON
 * string) into the counters the job list renders. `error` is the first
 * error-ish text the job reported; everything else defaults to zero so the
 * response shape never depends on the job type.
 */
function normalizeSyncSummary(raw: unknown): SyncJobSummary {
  const summary = asRecord(raw);
  const errorCandidate = ['error', 'lastError', 'errorCode', 'messageFa', 'reason']
    .map((key) => summary[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return {
    imported: summaryCount(summary, 'imported'),
    updated: summaryCount(summary, 'updated'),
    failed: summaryCount(summary, 'failed'),
    pushed: summaryCount(summary, 'pushed'),
    skipped: summaryCount(summary, 'skipped'),
    error: errorCandidate === undefined ? null : errorCandidate.trim().slice(0, 500),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function credentialsFrom(body: Record<string, unknown>): Record<string, string> {
  const raw = body['credentials'];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'credentials must be an object' });
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const valueText = text(value);
    if (valueText.length > 0) out[key] = valueText;
  }
  return out;
}

@ApiTags('channels')
@ApiBearerAuth()
@Controller()
export class ChannelsAdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly accounts: ChannelAccountService,
    private readonly sync: ChannelSyncService,
  ) {}

  private get sql(): Raw {
    return this.db as unknown as Raw;
  }

  private async channelInternalId(ctx: TenantContext, publicId: string): Promise<string | null> {
    const rows = await this.sql`
      select id::text as id from erp.sales_channels
      where public_id = ${publicId} and organization_id = ${ctx.orgId} limit 1
    `;
    return rows.length === 0 ? null : String(rows[0]!['id']);
  }

  private async accountInternalId(ctx: TenantContext, publicId: string): Promise<string | null> {
    const rows = await this.sql`
      select id::text as id from erp.channel_accounts
      where public_id = ${publicId} and organization_id = ${ctx.orgId} and deleted_at is null limit 1
    `;
    return rows.length === 0 ? null : String(rows[0]!['id']);
  }

  /** Fingerprint of the key Digikala should be holding: stored public key, else derived from the private key. */
  private storedRsaFingerprint(credentials: Readonly<Record<string, string>>): string | null {
    const publicKey = credentials['public_key'];
    const privateKey = credentials['private_key'];
    try {
      if (publicKey !== undefined && publicKey.length > 0) return publicKeyFingerprint(publicKey);
      if (privateKey !== undefined && privateKey.length > 0) {
        return publicKeyFingerprint(publicKeyFromPrivate(privateKey));
      }
      return null;
    } catch {
      return null;
    }
  }

  @Get('channels')
  @Permissions('channel.read')
  @ApiOperation({ summary: 'List channels with account counts' })
  async list(@CurrentTenant() ctx: TenantContext) {
    const rows = await this.sql`
      select c.public_id::text as id, c.code, c.name, c.is_active,
             (select count(*)::int from erp.channel_accounts a
               where a.channel_id = c.id and a.organization_id = ${ctx.orgId} and a.deleted_at is null) as account_count
      from erp.sales_channels c
      where c.organization_id = ${ctx.orgId}
      order by c.id
    `;
    return apiData(
      rows.map((row: Row) => ({
        id: String(row['id']),
        code: String(row['code']),
        name: String(row['name']),
        nameFa: String(row['name']),
        isActive: row['is_active'] === true,
        accountCount: Number(row['account_count'] ?? 0),
      })),
    );
  }

  @Get('channels/health')
  @Permissions('channel.read')
  @ApiOperation({ summary: 'Latest health check per channel account' })
  async health(@CurrentTenant() ctx: TenantContext) {
    const rows = await this.sql`
      select distinct on (h.channel_account_id)
             h.channel_account_id::text as account_id,
             case when h.auth_ok then 'ok' else 'fail' end as status, h.latency_ms, h.checked_at, h.error_message as message
      from erp.channel_health_checks h
      join erp.channel_accounts a on a.id = h.channel_account_id
      where a.organization_id = ${ctx.orgId}
      order by h.channel_account_id, h.checked_at desc
    `;
    return apiData(
      rows.map((row: Row) => ({
        accountId: String(row['account_id']),
        status: row['status'],
        latencyMs: row['latency_ms'],
        message: row['message'],
        checkedAt: row['checked_at'],
      })),
    );
  }

  @Get('channels/:channelId/accounts')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Accounts of one channel (with credential metadata)' })
  async accountsOfChannel(@CurrentTenant() ctx: TenantContext, @Param('channelId') channelId: string) {
    const channelInternal = await this.channelInternalId(ctx, channelId);
    if (channelInternal === null) return apiData([]);
    const rows = await this.sql`
      select a.public_id::text as id, a.name, a.external_account_id, a.seller_code, a.base_url,
             a.is_active, a.stock_push_enabled, a.stock_safety_qty, a.rate_limit_per_min,
             a.settings, a.last_health_check_at, c.code as channel_code,
             coalesce((select json_agg(json_build_object(
                 'keyName', cr.key_name, 'keyVersion', cr.key_version, 'rotatedAt', cr.rotated_at
               ) order by cr.key_name)
               from erp.channel_credentials cr
               where cr.channel_account_id = a.id and cr.is_active), '[]'::json) as credentials
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.channel_id = ${channelInternal}::bigint and a.organization_id = ${ctx.orgId} and a.deleted_at is null
      order by a.id
    `;
    return apiData(
      rows.map((row: Row) => ({
        id: String(row['id']),
        name: row['name'],
        nameFa: row['name'],
        channelCode: row['channel_code'],
        externalSellerId: row['external_account_id'],
        active: row['is_active'],
        credentialMeta:
          Array.isArray(row['credentials']) && row['credentials'].length > 0
            ? { keyName: (row['credentials'] as Array<Record<string, unknown>>)[0]!['keyName'], last4: '' }
            : undefined,
        externalAccountId: row['external_account_id'],
        sellerCode: row['seller_code'],
        baseUrl: row['base_url'],
        isActive: row['is_active'] === true,
        stockPushEnabled: row['stock_push_enabled'] === true,
        stockSafetyQty: row['stock_safety_qty'],
        rateLimitPerMin: row['rate_limit_per_min'],
        settings: row['settings'],
        lastHealthCheckAt: row['last_health_check_at'],
        credentials: row['credentials'],
      })),
    );
  }

  @Post('channels/:channelId/accounts')
  @Permissions('channel.account.create')
  @ApiOperation({ summary: 'Create a seller account and store its credentials' })
  async createAccount(
    @CurrentTenant() ctx: TenantContext,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const name = text(payload['name']);
    if (name.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'name is required' });
    }
    const channelInternal = await this.channelInternalId(ctx, channelId);
    if (channelInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'channel not found' });
    }

    const inserted = await this.sql`
      insert into erp.channel_accounts
        (organization_id, channel_id, name, external_account_id, seller_code, base_url,
         auth_type, rate_limit_per_min, stock_push_enabled, stock_safety_qty, settings, is_active, created_by, updated_by)
      values
        (${ctx.orgId}, ${channelInternal}::bigint, ${name},
         ${text(payload['externalAccountId']) || null}, ${text(payload['sellerCode']) || null},
         ${text(payload['baseUrl']) || null}, 'api_key',
         ${Number(payload['rateLimitPerMin'] ?? 60)}, ${payload['stockPushEnabled'] === false ? false : true},
         ${Number(payload['stockSafetyQty'] ?? 0)}, ${JSON.stringify(payload['settings'] ?? {})}::jsonb, true,
         ${ctx.actorId}, ${ctx.actorId})
      returning id::text as id, public_id::text as public_id
    `;

    const credentials = credentialsFrom(payload);
    if (Object.keys(credentials).length > 0) {
      await this.accounts.setCredentials({
        organizationId: ctx.orgId.toString(),
        accountId: inserted[0]!['id'] as string,
        credentials: credentials as Partial<Record<CredentialKeyName, string>>,
        actorId: ctx.actorId === null ? null : ctx.actorId.toString(),
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return apiData({ id: inserted[0]!['public_id'], name, credentialsStored: Object.keys(credentials) });
  }

  @Put('channel-accounts/:accountId/credentials')
  @Permissions('channel.credential.write')
  @ApiOperation({ summary: 'Create or rotate credentials for an account' })
  async setCredentials(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const credentials = credentialsFrom((body ?? {}) as Record<string, unknown>);
    if (Object.keys(credentials).length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'credentials is empty' });
    }
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const metadata = await this.accounts.setCredentials({
      organizationId: ctx.orgId.toString(),
      accountId: accountInternal,
      credentials: credentials as Partial<Record<CredentialKeyName, string>>,
      actorId: ctx.actorId === null ? null : ctx.actorId.toString(),
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return apiData({ stored: Object.keys(credentials), metadata });
  }

  @Get('channel-accounts/:accountId/rsa-keypair')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Public half of the account RSA key-pair (private key never returned)' })
  async rsaKeypair(@CurrentTenant() ctx: TenantContext, @Param('accountId') accountId: string) {
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    return apiData(await this.accounts.rsaKeypair(ctx.orgId.toString(), accountInternal));
  }

  @Post('channel-accounts/:accountId/rsa-keypair')
  @Permissions('channel.credential.write')
  @ApiOperation({ summary: 'Generate (2048/4096-bit) or import the Digikala RSA key-pair' })
  async setRsaKeypair(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const privateKeyPem = payload['privateKeyPem'];
    if (privateKeyPem !== undefined && privateKeyPem !== null && typeof privateKeyPem !== 'string') {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'privateKeyPem must be a string' });
    }
    const privateKeyText = typeof privateKeyPem === 'string' ? privateKeyPem : '';
    if (privateKeyText.length > 65_536) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'privateKeyPem is too large' });
    }
    const bitsRaw = payload['bits'];
    let bits: RsaKeyBits | undefined;
    if (bitsRaw !== undefined && bitsRaw !== null && bitsRaw !== '') {
      const parsed = Number(bitsRaw);
      if (parsed !== 2048 && parsed !== 4096) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'bits must be 2048 or 4096' });
      }
      bits = parsed;
    }
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const result = await this.accounts.setRsaKeypair({
      organizationId: ctx.orgId.toString(),
      accountId: accountInternal,
      ...(privateKeyText.trim().length > 0 ? { privateKeyPem: privateKeyText } : {}),
      ...(bits === undefined ? {} : { bits }),
      actorId: ctx.actorId === null ? null : ctx.actorId.toString(),
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return apiData(result);
  }

  /**
   * Compare a key read from the Digikala panel with the key stored here.
   * Accepts SPKI PEM, PKCS#1 PEM or raw base64 DER and compares SHA-256
   * fingerprints, so formatting differences do not matter.
   */
  @Post('channel-accounts/:accountId/rsa-keypair/compare')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Compare a pasted public key with the stored RSA public key' })
  async compareRsaKey(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const publicKey = payload['publicKey'];
    const publicKeyText = typeof publicKey === 'string' ? publicKey.trim() : '';
    if (publicKeyText.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'publicKey is required' });
    }
    if (publicKeyText.length > 65_536) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'publicKey is too large' });
    }
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    let providedFingerprint: string;
    try {
      providedFingerprint = publicKeyFingerprint(normalizePublicKey(publicKeyText));
    } catch {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'کلید عمومی معتبر نیست؛ PEM (SPKI یا PKCS#1) یا Base64 DER بفرستید.',
      });
    }
    const storedFingerprint = this.storedRsaFingerprint(await this.accounts.decryptActive(accountInternal));
    if (storedFingerprint === null) {
      throw new BadRequestException({
        code: 'RSA_KEY_NOT_FOUND',
        message: 'کلید عمومی برای این حساب ثبت نشده است.',
      });
    }
    return apiData({
      match: storedFingerprint === providedFingerprint,
      storedFingerprint,
      providedFingerprint,
    });
  }

  /**
   * Replaces whatever key-pair is stored with a brand-new 4096-bit pair.
   * Used when Digikala still holds an older public key, so validation codes
   * are encrypted with a key our private key cannot decrypt.
   */
  @Post('channel-accounts/:accountId/rsa-keypair/reset')
  @Permissions('channel.credential.write')
  @ApiOperation({ summary: 'Overwrite the RSA key-pair with a new 4096-bit pair' })
  async resetRsaKeypair(@CurrentTenant() ctx: TenantContext, @Param('accountId') accountId: string) {
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const result = await this.accounts.resetRsaKeypair({
      organizationId: ctx.orgId.toString(),
      accountId: accountInternal,
      actorId: ctx.actorId === null ? null : ctx.actorId.toString(),
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return apiData(result);
  }

  /**
   * Exchanges Digikala's short-lived validation code for access/refresh tokens.
   * Flow: base64-decode the code -> RSA-decrypt with the stored private key ->
   * POST /open-api/v1/auth/token -> store access_token/refresh_token.
   */
  /**
   * Decrypt-only check: tells the operator whether the panel validation code
   * matches the stored private key, without consuming it for a token exchange.
   */
  @Post('channel-accounts/:accountId/rsa-keypair/verify')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Check that a validation code matches the stored RSA key' })
  async verifyRsaKey(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const validationCode = text(payload['validationCode']);
    if (validationCode.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'validationCode is required' });
    }
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const credentials = await this.accounts.decryptActive(accountInternal);
    const privateKey = credentials['private_key'];
    if (privateKey === undefined || privateKey.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'کلید خصوصی ثبت نشده است.' });
    }
    const storedFingerprint = this.storedRsaFingerprint(credentials);
    try {
      const result = decryptValidationCode(validationCode, privateKey);
      return apiData({ ok: true, decryption: result.decryption, storedFingerprint });
    } catch (error) {
      return apiData({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        storedFingerprint,
      });
    }
  }

  @Post('channel-accounts/:accountId/digikala/token')
  @Permissions('channel.credential.write')
  @ApiOperation({ summary: 'Activate Digikala tokens from the panel validation code' })
  async digikalaToken(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const validationCode = text(payload['validationCode']);
    if (validationCode.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'validationCode is required' });
    }
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const credentials = await this.accounts.decryptActive(accountInternal);
    const privateKey = credentials['private_key'];
    if (privateKey === undefined || privateKey.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ابتدا در همین پنجره جفت‌کلید RSA را بسازید یا کلید خصوصی را بارگذاری کنید.',
      });
    }
    const clientCode = text(payload['clientCode']) || credentials['client_code'] || credentials['client_id'] || '';
    const clientSecret = text(payload['clientSecret']) || credentials['client_secret'] || '';
    let storedFingerprint: string | undefined;
    try {
      storedFingerprint = publicKeyFingerprint(publicKeyFromPrivate(privateKey));
    } catch {
      storedFingerprint = undefined;
    }
    try {
      const result = await activateDigikalaToken({
        validationCode,
        privateKeyPem: privateKey,
        ...(storedFingerprint === undefined ? {} : { publicKeyFingerprint: storedFingerprint }),
        ...(clientCode.length > 0 ? { clientCode } : {}),
        ...(clientSecret.length > 0 ? { clientSecret } : {}),
        ...(credentials['base_url'] === undefined ? {} : { baseUrl: credentials['base_url'] }),
      });
      const toStore: Record<string, string> = { access_token: result.accessToken };
      if (result.refreshToken !== null) toStore['refresh_token'] = result.refreshToken;
      if (clientCode.length > 0) toStore['client_code'] = clientCode;
      if (clientSecret.length > 0) toStore['client_secret'] = clientSecret;
      await this.accounts.setCredentials({
        organizationId: ctx.orgId.toString(),
        accountId: accountInternal,
        credentials: toStore,
        actorId: ctx.actorId === null ? null : ctx.actorId.toString(),
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // eslint-disable-next-line no-console
      console.log(`[digikala] token activated via ${result.payloadVariant} (${result.decryption}), refresh=${result.refreshToken !== null}`);
      return apiData({
        ok: true,
        decryption: result.decryption,
        payloadVariant: result.payloadVariant,
        expiresIn: result.expiresIn,
        hasRefreshToken: result.refreshToken !== null,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[digikala] token activation failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof RsaDecryptionError) {
        throw new BadRequestException({
          code: 'DIGIKALA_RSA_DECRYPT_FAILED',
          message: error.message,
          details: {
            fingerprint: error.fingerprint,
            attempts: [...error.attempts],
            requiresPublicKeyMatch: true,
          },
        });
      }
      throw new BadRequestException({
        code: 'DIGIKALA_TOKEN_FAILED',
        message: error instanceof Error ? error.message : String(error),
        ...(storedFingerprint === undefined
          ? {}
          : { details: { fingerprint: storedFingerprint } }),
      });
    }
  }

  @Post('channel-accounts/:accountId/test')
  @Permissions('channel.account.test')
  @ApiOperation({ summary: 'Authenticate against the channel with stored credentials' })
  async test(@CurrentTenant() ctx: TenantContext, @Param('accountId') accountId: string) {
    const accountInternal = await this.accountInternalId(ctx, accountId);
    if (accountInternal === null) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    }
    const resolved = await this.accounts.resolveForSync(ctx.orgId.toString(), accountInternal);
    try {
      await resolved.adapter.authenticate(resolved.account);
      return apiData({ ok: true });
    } catch (error) {
      return apiData({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }


  @Put('channel-accounts/:accountId')
  @Permissions('channel.account.update')
  @ApiOperation({ summary: 'Update a channel account (name/active)' })
  async updateAccount(
    @CurrentTenant() ctx: TenantContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const name = typeof payload['name'] === 'string' && payload['name'].trim().length >= 2 ? payload['name'].trim() : null;
    const isActive = typeof payload['isActive'] === 'boolean' ? payload['isActive'] : null;
    const rows = await this.sql`
      update erp.channel_accounts
      set name = coalesce(${name}, name),
          is_active = coalesce(${isActive}::boolean, is_active),
          updated_at = now(), updated_by = ${ctx.actorId}
      where public_id = ${accountId} and organization_id = ${ctx.orgId} and deleted_at is null
      returning public_id::text as id
    `;
    if (rows.length === 0) throw new BadRequestException({ code: 'NOT_FOUND', message: 'account not found' });
    return apiData({ id: String(rows[0]!['id']) });
  }

  @Delete('channel-accounts/:accountId')
  @HttpCode(200)
  @Permissions('channel.account.delete')
  @ApiOperation({ summary: 'Soft-delete a channel account' })
  async deleteAccount(@CurrentTenant() ctx: TenantContext, @Param('accountId') accountId: string) {
    await this.sql`
      update erp.channel_accounts
      set deleted_at = now(), is_active = false, updated_at = now(), updated_by = ${ctx.actorId}
      where public_id = ${accountId} and organization_id = ${ctx.orgId} and deleted_at is null
    `;
    return apiData({ id: accountId, deleted: true });
  }

  @Get('channel-sync-jobs')
  @Permissions('channel.sync.read')
  @ApiOperation({ summary: 'Recent sync jobs' })
  async jobs(@CurrentTenant() ctx: TenantContext, @Query() query: Record<string, unknown>) {
    const limit = Math.min(100, Math.max(1, Number(query['limit'] ?? 25)));
    const rows = await this.sql`
      select j.public_id::text as id, j.job_type, j.status, j.attempts, j.max_attempts,
             j.last_error, j.created_at, j.started_at, j.finished_at, j.response_summary,
             a.name as account_name, c.code as channel_code, c.name as channel_name
      from erp.channel_sync_jobs j
      join erp.channel_accounts a on a.id = j.channel_account_id
      join erp.sales_channels c on c.id = a.channel_id
      where j.organization_id = ${ctx.orgId}
      order by j.id desc limit ${limit}
    `;
    return apiData(
      rows.map((row: Row) => ({
        id: String(row['id']),
        jobType: row['job_type'],
        status: row['status'],
        attempts: row['attempts'],
        maxAttempts: row['max_attempts'],
        lastError: row['last_error'],
        createdAt: row['created_at'],
        startedAt: row['started_at'],
        finishedAt: row['finished_at'],
        progress: row['response_summary'] ?? {},
        summary: normalizeSyncSummary(row['response_summary']),
        account: { name: row['account_name'] },
        channel: { code: row['channel_code'], nameFa: row['channel_name'], name: row['channel_name'] },
      })),
    );
  }

  @Post('channel-sync-jobs')
  @Permissions('channel.sync.trigger')
  @ApiOperation({ summary: 'Queue a sync run for the first active account of a channel' })
  async triggerSync(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const channelId = text(payload['channelId']);
    const type = text(payload['type']);
    if (channelId.length === 0 || type.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'channelId and type are required',
      });
    }
    if (type.length > 50) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'type is too long',
      });
    }
    if (!(SYNC_TRIGGER_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'unsupported sync type',
      });
    }

    // Prefer an account that actually has credentials; the first account of a
    // channel is often an empty placeholder created before the API keys.
    let accounts = await this.sql`
      select a.id::text as id
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where c.public_id = ${channelId}
        and c.organization_id = ${ctx.orgId}
        and a.organization_id = ${ctx.orgId}
        and a.is_active = true
        and a.deleted_at is null
        and exists (
          select 1 from erp.channel_credentials cr
          where cr.channel_account_id = a.id and cr.is_active = true
        )
      order by a.id
      limit 1
    `;
    if (accounts.length === 0) {
      accounts = await this.sql`
        select a.id::text as id
        from erp.channel_accounts a
        join erp.sales_channels c on c.id = a.channel_id
        where c.public_id = ${channelId}
          and c.organization_id = ${ctx.orgId}
          and a.organization_id = ${ctx.orgId}
          and a.is_active = true
          and a.deleted_at is null
        order by a.id
        limit 1
      `;
    }
    const account = accounts[0];
    if (account === undefined) {
      throw new AppError('NOT_FOUND', {
        message: 'حساب فعالی برای این کانال یافت نشد.',
      });
    }

    // The service owns debouncing, capability checks and the mirrored job row;
    // `product_push` from the SPA is normalised to the product_import job type.
    // `dryRun` is carried on the operation key so the worker can see it.
    const triggered = await this.sync.trigger({
      organizationId: ctx.orgId.toString(),
      accountId: String(account['id']),
      type: type as SyncTriggerType,
      scope: { dryRun: payload['dryRun'] === true },
    });

    // Execute after the HTTP response: the caller gets the job id immediately.
    setImmediate(() => {
      void this.sync.runJob(triggered.jobId).catch(() => undefined);
    });

    return apiData({ id: triggered.jobId, status: triggered.status });
  }

  @Post('channel-sync-jobs/:jobId/retry')
  @Permissions('channel.sync.retry')
  @ApiOperation({ summary: 'Re-queue a failed sync job' })
  async retry(@CurrentTenant() ctx: TenantContext, @Param('jobId') jobId: string) {
    const rows = await this.sql`
      update erp.channel_sync_jobs
      set status = 'queued', next_run_at = now(), locked_at = null, locked_by = null,
          attempts = 0, last_error = null, updated_at = now(), updated_by = ${ctx.actorId}
      where public_id = ${jobId} and organization_id = ${ctx.orgId}
      returning id::text as id, public_id::text as public_id
    `;
    if (rows.length === 0) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'job not found' });
    }
    return apiData({ id: String(rows[0]!['id']), status: 'queued' });
  }
}
