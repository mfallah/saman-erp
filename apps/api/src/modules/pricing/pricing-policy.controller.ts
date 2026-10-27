/**
 * Channel pricing-policy API: one policy per channel account, applied to all
 * mapped products and pushed to the channel.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { TENANT, type TenantAccessor, type TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { AccountPricingParam, ChannelPolicyBody, parseWith } from './pricing.dto';
import { PricingPolicyService } from './pricing-policy.service';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller()
export class PricingPolicyController {
  constructor(
    private readonly policies: PricingPolicyService,
    @Inject(TENANT) private readonly tenant: TenantAccessor,
  ) {}

  private withTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return this.tenant.run(ctx, fn);
  }

  @Get('pricing/channels')
  @Permissions('pricing.rule.read')
  @ApiOperation({ summary: 'One pricing policy row per active channel account' })
  async list(@CurrentTenant() ctx: TenantContext) {
    return apiData(await this.withTenant(ctx, () => this.policies.listChannelAccounts()));
  }

  @Get('pricing/channels/:accountId/policy')
  @Permissions('pricing.rule.read')
  @ApiOperation({ summary: 'Pricing policy of one channel account' })
  async getOne(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { accountId } = parseWith(AccountPricingParam, params);
    return apiData(await this.withTenant(ctx, () => this.policies.getPolicy(accountId)));
  }

  @Put('pricing/channels/:accountId/policy')
  @Permissions('pricing.rule.update')
  @ApiOperation({ summary: 'Replace the pricing policy of one channel account' })
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { accountId } = parseWith(AccountPricingParam, params);
    const input = parseWith(ChannelPolicyBody, body);
    return apiData(await this.withTenant(ctx, () => this.policies.setPolicy(accountId, input)));
  }

  @Post('pricing/channels/:accountId/apply')
  @HttpCode(200)
  @Permissions('pricing.rule.update')
  @ApiOperation({ summary: 'Compute prices for all mapped variants and push them to the channel' })
  async apply(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { accountId } = parseWith(AccountPricingParam, params);
    return apiData(
      await this.withTenant(ctx, () => this.policies.applyForAccount(ctx.orgId, accountId)),
    );
  }
}
