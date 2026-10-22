import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
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
