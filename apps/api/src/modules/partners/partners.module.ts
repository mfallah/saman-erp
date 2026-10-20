/** Partners module: partners, shareholders, profit distribution, settlements. */
import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { PartnersRepository } from './partners.repository';
import { ProfitRepository } from './profit.repository';
import { SettlementsRepository } from './settlements.repository';
import { PartnersService } from './partners.service';
import { ProfitDistributionService } from './profit-distribution.service';
import { SettlementsService } from './settlements.service';
import { PartnersController } from './controllers/partners.controller';

@Module({
  imports: [AccountingModule],
  controllers: [PartnersController],
  providers: [
    PartnersRepository,
    ProfitRepository,
    SettlementsRepository,
    PartnersService,
    ProfitDistributionService,
    SettlementsService,
  ],
  exports: [PartnersService, ProfitDistributionService, SettlementsService],
})
export class PartnersModule {}
