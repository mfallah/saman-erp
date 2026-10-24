import { Module } from '@nestjs/common';

import { PricingRulesController } from './pricing-rules.controller';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({
  controllers: [PricingController, PricingRulesController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
