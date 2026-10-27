import { Module } from '@nestjs/common';

import { PricingPolicyController } from './pricing-policy.controller';
import { PricingPolicyService } from './pricing-policy.service';
import { PricingRulesController } from './pricing-rules.controller';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({
  controllers: [PricingController, PricingRulesController, PricingPolicyController],
  providers: [PricingService, PricingPolicyService],
  exports: [PricingService, PricingPolicyService],
})
export class PricingModule {}
