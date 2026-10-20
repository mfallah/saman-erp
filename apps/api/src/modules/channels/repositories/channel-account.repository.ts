import type { Db } from '../../../common/contracts';
import type { ChannelCode } from '../domain/channel.types';
import { asDate, asNumber, asRecord, asString, asString as s } from '../infrastructure/sql';

export interface ChannelAccountRow {
  readonly id: string;
  readonly publicId: string;
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  readonly organizationId: string;
  readonly name: string;
  readonly externalAccountId: string | null;
  readonly baseUrl: string | null;
  readonly authType: string;
  readonly rateLimitPerMin: number;
  readonly stockPushEnabled: boolean;
  readonly stockSafetyQty: string;
  readonly settings: Record<string, unknown>;
  readonly isActive: boolean;
}

interface RawAccountRow {
  id: unknown;
  public_id: unknown;
  channel_id: unknown;
  channel_code: unknown;
  organization_id: unknown;
  name: unknown;
  external_account_id: unknown;
  base_url: unknown;
  auth_type: unknown;
  rate_limit_per_min: unknown;
  stock_push_enabled: unknown;
  stock_safety_qty: unknown;
  settings: unknown;
  is_active: unknown;
}

function mapAccount(row: RawAccountRow): ChannelAccountRow {
  return {
    id: s(row.id),
    publicId: s(row.public_id),
    channelId: s(row.channel_id),
    channelCode: s(row.channel_code) as ChannelCode,
    organizationId: s(row.organization_id),
    name: s(row.name),
    externalAccountId: row.external_account_id === null ? null : s(row.external_account_id),
    baseUrl: row.base_url === null ? null : s(row.base_url),
    authType: s(row.auth_type),
    rateLimitPerMin: asNumber(row.rate_limit_per_min),
    stockPushEnabled: row.stock_push_enabled === true,
    stockSafetyQty: s(row.stock_safety_qty),
    settings: asRecord(row.settings),
    isActive: row.is_active === true,
  };
}

export interface ChannelAccountRepositoryPort {
  findById(organizationId: string, id: string): Promise<ChannelAccountRow | null>;
  findByPublicId(organizationId: string, publicId: string): Promise<ChannelAccountRow | null>;
  findForWebhook(
    channelCode: ChannelCode,
    accountPublicId?: string,
  ): Promise<ChannelAccountRow | null>;
  setStockSafety(
    organizationId: string,
    accountId: string,
    value: string,
  ): Promise<void>;
}

export class SqlChannelAccountRepository implements ChannelAccountRepositoryPort {
  constructor(private readonly db: Db) {}

  async findById(organizationId: string, id: string): Promise<ChannelAccountRow | null> {
    const rows = await this.db<RawAccountRow[]>`
      select a.id, a.public_id, a.channel_id, c.code as channel_code, a.organization_id, a.name,
             a.external_account_id, a.base_url, a.auth_type, a.rate_limit_per_min,
             a.stock_push_enabled, a.stock_safety_qty, a.settings, a.is_active
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.organization_id = ${organizationId}::bigint
        and a.id = ${id}::bigint
        and a.deleted_at is null`;
    return rows[0] === undefined ? null : mapAccount(rows[0]);
  }

  async findByPublicId(organizationId: string, publicId: string): Promise<ChannelAccountRow | null> {
    const rows = await this.db<RawAccountRow[]>`
      select a.id, a.public_id, a.channel_id, c.code as channel_code, a.organization_id, a.name,
             a.external_account_id, a.base_url, a.auth_type, a.rate_limit_per_min,
             a.stock_push_enabled, a.stock_safety_qty, a.settings, a.is_active
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.organization_id = ${organizationId}::bigint
        and a.public_id = ${publicId}::uuid
        and a.deleted_at is null`;
    return rows[0] === undefined ? null : mapAccount(rows[0]);
  }

  /**
   * Webhook URLs carry the account public UUID. Without it, only a single
   * active account for that channel is accepted (never "pick any").
   */
  async findForWebhook(
    channelCode: ChannelCode,
    accountPublicId?: string,
  ): Promise<ChannelAccountRow | null> {
    if (accountPublicId !== undefined) {
      const rows = await this.db<RawAccountRow[]>`
        select a.id, a.public_id, a.channel_id, c.code as channel_code, a.organization_id, a.name,
             a.external_account_id, a.base_url, a.auth_type, a.rate_limit_per_min,
             a.stock_push_enabled, a.stock_safety_qty, a.settings, a.is_active
        from erp.channel_accounts a
        join erp.sales_channels c on c.id = a.channel_id
        where a.public_id = ${accountPublicId}::uuid
          and c.code = ${channelCode}
          and a.is_active = true
          and a.deleted_at is null
        limit 1`;
      return rows[0] === undefined ? null : mapAccount(rows[0]);
    }
    const rows = await this.db<RawAccountRow[]>`
      select a.id, a.public_id, a.channel_id, c.code as channel_code, a.organization_id, a.name,
             a.external_account_id, a.base_url, a.auth_type, a.rate_limit_per_min,
             a.stock_push_enabled, a.stock_safety_qty, a.settings, a.is_active
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where c.code = ${channelCode}
        and a.is_active = true
        and a.deleted_at is null
      order by a.id
      limit 2`;
    return rows.length === 1 && rows[0] !== undefined ? mapAccount(rows[0]) : null;
  }

  async setStockSafety(
    organizationId: string,
    accountId: string,
    value: string,
  ): Promise<void> {
    await this.db`
      update erp.channel_accounts
      set stock_safety_qty = ${value}::numeric, updated_at = now()
      where organization_id = ${organizationId}::bigint and id = ${accountId}::bigint`;
  }
}

export interface ChannelAccountSummary {
  readonly id: string;
  readonly publicId: string;
  readonly name: string;
  readonly channelCode: ChannelCode;
  readonly isActive: boolean;
  readonly lastHealthCheckAt: Date | null;
}

export function summarize(row: ChannelAccountRow, lastHealthCheckAt: Date | null = null): ChannelAccountSummary {
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    channelCode: row.channelCode,
    isActive: row.isActive,
    lastHealthCheckAt,
  };
}

export { asDate };
