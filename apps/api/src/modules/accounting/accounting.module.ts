/**
 * Accounting module (CoA, periods, journals, posting engine, closing, tax,
 * valuation, reports). Depends only on the platform seams in `common/contracts`.
 */
import { Module } from '@nestjs/common';
import { ChartOfAccountsRepository } from './coa/chart-of-accounts.repository';
import { ChartOfAccountsService } from './coa/chart-of-accounts.service';
import { FiscalCalendarRepository } from './periods/fiscal-calendar.repository';
import { FiscalCalendarService } from './periods/fiscal-calendar.service';
import { JournalRepository } from './journal/journal.repository';
import { JournalService } from './journal/journal.service';
import { PostingService } from './posting/posting.service';
import { ClosingRepository } from './closing/closing.repository';
import { ClosingService } from './closing/closing.service';
import { TaxRepository } from './tax/tax.repository';
import { TaxService } from './tax/tax.service';
import { ValuationRepository } from './valuation/valuation.repository';
import { ValuationService } from './valuation/valuation.service';
import { AccountingReportsRepository } from './reports/accounting-reports.repository';
import { AccountingReportsService } from './reports/accounting-reports.service';
import { AccountingStructureController } from './controllers/structure.controller';
import { JournalController } from './controllers/journal.controller';
import { AccountingReportsController } from './controllers/reports.controller';
import { AccountingOperationsController } from './controllers/operations.controller';

@Module({
  controllers: [
    AccountingStructureController,
    JournalController,
    AccountingReportsController,
    AccountingOperationsController,
  ],
  providers: [
    ChartOfAccountsRepository,
    ChartOfAccountsService,
    FiscalCalendarRepository,
    FiscalCalendarService,
    JournalRepository,
    JournalService,
    PostingService,
    ClosingRepository,
    ClosingService,
    TaxRepository,
    TaxService,
    ValuationRepository,
    ValuationService,
    AccountingReportsRepository,
    AccountingReportsService,
  ],
  exports: [
    ChartOfAccountsService,
    FiscalCalendarService,
    JournalService,
    PostingService,
    ClosingService,
    ValuationService,
    AccountingReportsService,
    TaxService,
    // Repositories are exported so treasury/partners/reporting can compose
    // multi-module postings inside one transaction without touching tables.
    ChartOfAccountsRepository,
    FiscalCalendarRepository,
    JournalRepository,
    ClosingRepository,
    TaxRepository,
    ValuationRepository,
    AccountingReportsRepository,
  ],
})
export class AccountingModule {}
