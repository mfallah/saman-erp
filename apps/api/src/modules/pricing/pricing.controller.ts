import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { TENANT, type TenantAccessor, type TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import {
  AccountPricingParam,
  ChannelPricingParam,
  PreviewBatchBody,
  PreviewQuery,
  PricingPolicyBody,
  parseWith,
} from './pricing.dto';
import { PricingService } from './pricing.service';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller()
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    @Inject(TENANT) private readonly tenant: TenantAccessor,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** PricingService reads the tenant from AsyncLocalStorage; bind the resolved request context. */
  private withTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return this.tenant.run(ctx, fn);
  }

  @Get('pricing/policies')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Pricing policies across every channel account' })
  async listAll(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.withTenant(ctx, () => this.pricing.listPolicies()));
  }

  @Get('channels/:channelId/pricing-policy')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'All channel-account pricing policies for one channel' })
  async listForChannel(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { channelId } = parseWith(ChannelPricingParam, params);
    return apiData(await this.withTenant(ctx, () => this.pricing.listChannelPolicies(channelId)));
  }

  @Put('channel-accounts/:accountId/pricing-policy')
  @Permissions('channel.account.update')
  @ApiOperation({ summary: 'Replace the pricing policy of a channel account' })
  async setPolicy(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { accountId } = parseWith(AccountPricingParam, params);
    const input = parseWith(PricingPolicyBody, body);
    return apiData(await this.withTenant(ctx, () => this.pricing.setPolicy(accountId, input)));
  }


  @Post('channel-accounts/:accountId/pricing/apply')
  @HttpCode(200)
  @Permissions('channel.account.update')
  @ApiOperation({ summary: 'Compute and publish per-channel prices, then push them to the channel' })
  async apply(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { accountId } = parseWith(AccountPricingParam, params);
    const payload = (body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(payload['variantIds']) ? payload['variantIds'] : undefined;
    const variantIds = rawIds?.filter((value): value is string => typeof value === 'string');
    const basePriceRaw = payload['basePrice'];
    const basePrice =
      typeof basePriceRaw === 'number' || typeof basePriceRaw === 'string' ? String(basePriceRaw) : undefined;
    const result = await this.withTenant(ctx, () =>
      this.pricing.applyToAccount({
        accountId,
        ...(variantIds === undefined ? {} : { variantIds }),
        ...(basePrice === undefined ? {} : { basePrice }),
      }),
    );
    try {
      const { ChannelSyncService } = await import('../channels/services/channel-sync.service');
      const sync = this.moduleRef.get(ChannelSyncService, { strict: false });
      const job = await sync.trigger({
        organizationId: ctx.orgId.toString(),
        accountId: result.accountInternalId,
        type: 'price_push',
        force: true,
      });
      setImmediate(() => {
        void sync.runJob(job.jobId).catch(() => undefined);
      });
      return apiData({ ...result, jobId: job.jobId, queued: true });
    } catch (error) {
      return apiData({
        ...result,
        queued: false,
        queueError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @Get('pricing/preview')
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Live price calculation for one variant and channel account' })
  async preview(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const { variantId, accountId } = parseWith(PreviewQuery, query);
    return apiData(await this.withTenant(ctx, () => this.pricing.computeForVariant({ accountId, variantId })));
  }

  @Post('pricing/preview-batch')
  @HttpCode(200)
  @Permissions('channel.account.read')
  @ApiOperation({ summary: 'Live price calculation for up to 500 variants' })
  async previewBatch(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const { accountId, variantIds } = parseWith(PreviewBatchBody, body);
    return apiData(await this.withTenant(ctx, () => this.pricing.computeBatch(accountId, variantIds)));
  }
}
