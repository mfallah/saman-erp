/**
 * One pricing policy per sales-channel account (replaces the two-menu
 * `/pricing/lists` + `/pricing/rules` flow).
 *
 * The policy lives in `erp.channel_accounts.settings.pricing` and is applied to
 * every product mapped to the account; the resulting prices are upserted into
 * the account's channel price list and, when `autoPush` is on, pushed to the
 * channel through `ChannelSyncService`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { AppError } from '@saman/shared';
import { DB, TENANT, type Db, type TenantAccessor, type TenantContext } from '../../common/contracts';
import { PricingService } from './pricing.service';
import type {
  ChannelPricingAccountView,
  PricingApplyResult,
  PricingPolicy,
  PricingPolicyInput,
} from './pricing.types';

interface ChannelAccountPolicyRow {
  readonly account_id: string;
  readonly account_name: string;
  readonly settings: unknown;
  readonly channel_code: string;
  readonly channel_name: string;
  readonly mapped_variants: number;
  readonly last_applied_at: string | null;
  readonly last_push_status: string | null;
}

@Injectable()
export class PricingPolicyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TENANT) private readonly tenant: TenantAccessor,
    private readonly pricing: PricingService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async listChannelAccounts(): Promise<readonly ChannelPricingAccountView[]> {
    const ctx = this.tenant.get();
    const orgId = ctx.orgId.toString();
    const rows = await this.db<ChannelAccountPolicyRow[]>`
      select a.public_id::text as account_id,
             a.name as account_name,
             a.settings,
             c.code as channel_code,
             c.name as channel_name,
             (
               select count(distinct m.product_variant_id)::int
               from erp.channel_product_mappings m
               where m.channel_account_id = a.id
                 and m.deleted_at is null
             ) as mapped_variants,
             (
               select to_char(
                        max(greatest(i.created_at, i.updated_at)) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                      )
               from erp.price_list_items i
               join erp.price_lists l on l.id = i.price_list_id
               where l.organization_id = a.organization_id
                 and l.deleted_at is null
                 and (l.id = a.price_list_id or l.channel_account_id = a.id)
                 and i.deleted_at is null
             ) as last_applied_at,
             (
               select j.status
               from erp.channel_sync_jobs j
               where j.channel_account_id = a.id
                 and j.job_type = 'push_price'
               order by j.id desc
               limit 1
             ) as last_push_status
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.organization_id = ${orgId}
        and c.organization_id = ${orgId}
        and a.deleted_at is null
        and a.is_active = true
      order by c.id, a.id
    `;
    return rows.map((row) => ({
      accountId: row.account_id,
      channelCode: row.channel_code,
      channelName: row.channel_name,
      accountName: row.account_name,
      policy: this.pricing.policyFromAccount(row.settings, row.channel_code),
      lastAppliedAt: row.last_applied_at,
      lastPushStatus: row.last_push_status,
      mappedVariants: Number(row.mapped_variants ?? 0),
    }));
  }

  async getPolicy(accountId: string): Promise<PricingPolicy> {
    return this.pricing.getPolicy(accountId);
  }

  async setPolicy(accountId: string, input: PricingPolicyInput): Promise<PricingPolicy> {
    return this.pricing.setPolicy(accountId, input);
  }

  /**
   * Compute + persist prices for every mapped variant of the account, then push
   * when the policy allows it. Safe to call from the channel sync worker: the
   * tenant context is synthesized when no request context exists.
   */
  async applyForAccount(
    orgId: bigint | string,
    accountId: string,
    options?: { onlyIfAutoApply?: boolean },
  ): Promise<PricingApplyResult> {
    const context = this.contextFor(orgId);
    return this.tenant.run(context, () => this.runApply(orgId, accountId, options));
  }

  private async runApply(
    orgId: bigint | string,
    accountId: string,
    options?: { onlyIfAutoApply?: boolean },
  ): Promise<PricingApplyResult> {
    const policy = await this.pricing.getPolicy(accountId);
    if (options?.onlyIfAutoApply === true && !policy.autoApply) {
      return { accountId, applied: 0, pushed: 0, skipped: 'autoApply_disabled' };
    }

    const result = await this.pricing.applyPolicyToAccount(accountId);
    let pushed = 0;
    let pushError: string | undefined;
    if (policy.autoPush) {
      try {
        const { ChannelSyncService } = await import('../channels/services/channel-sync.service');
        const sync = this.moduleRef.get(ChannelSyncService, { strict: false });
        const job = await sync.trigger({
          organizationId: orgId.toString(),
          accountId: result.accountInternalId,
          type: 'price_push',
          force: true,
        });
        const completed = await sync.runJob(job.jobId);
        const count = Number(completed.summary['pushed'] ?? 0);
        pushed = Number.isFinite(count) ? count : 0;
        if (completed.status !== 'succeeded') pushError = 'push_failed';
      } catch (error) {
        pushError = error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error);
      }
    }

    return {
      accountId,
      applied: result.applied,
      pushed,
      missingCommission: result.missingCommission,
      ...(pushError === undefined ? {} : { pushError }),
    };
  }

  private contextFor(orgId: bigint | string): TenantContext {
    const existing = this.tenant.tryGet();
    if (existing !== undefined && existing.orgId.toString() === orgId.toString()) return existing;
    return {
      requestId: `pricing-auto-${Date.now().toString(36)}`,
      orgId: typeof orgId === 'bigint' ? orgId : BigInt(orgId),
      orgPublicId: '',
      actorId: null,
      actorPublicId: null,
      permissions: [],
      branchIds: null,
      warehouseIds: null,
    };
  }
}
