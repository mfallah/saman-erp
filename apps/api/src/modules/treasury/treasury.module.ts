/** Treasury module: payments, cheques, bank reconciliation, cash sessions. */
import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { PaymentRepository } from './payments/payment.repository';
import { PaymentService } from './payments/payment.service';
import { ChequeRepository } from './cheque/cheque.repository';
import { ChequeService } from './cheque/cheque.service';
import { BankRepository } from './bank/bank.repository';
import { BankService } from './bank/bank.service';
import { CashRepository } from './cash/cash.repository';
import { CashService } from './cash/cash.service';
import { TreasuryController } from './controllers/treasury.controller';

@Module({
  imports: [AccountingModule],
  controllers: [TreasuryController],
  providers: [
    PaymentRepository,
    PaymentService,
    ChequeRepository,
    ChequeService,
    BankRepository,
    BankService,
    CashRepository,
    CashService,
  ],
  exports: [PaymentService, ChequeService, BankService, CashService],
})
export class TreasuryModule {}
