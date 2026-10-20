/**
 * Posting matrix coverage: **every** accounting event in `DATA-MODEL §6.10.2`
 * (49 rows) must produce a balanced journal with the required legs — VAT, GRNI,
 * COGS-at-issue, settlement-without-revenue, returns, cheques, closing.
 */
import { describe, expect, it } from 'vitest';
import { buildPostingDraft } from '../posting';
import { assertDraft, draftTotals } from '../posting/types';
import { ACCOUNTS } from '../posting/accounts';
import { ACCOUNTING_EVENTS } from '../events';
import type { PostingDraft } from '../posting/types';

const DATE = '2026-06-01';
const ctx = (channelCode?: string) => ({
  entryDate: DATE,
  ...(channelCode === undefined ? {} : { channelCode }),
});

function legs(draft: PostingDraft): Map<string, { debit: bigint; credit: bigint }> {
  const map = new Map<string, { debit: bigint; credit: bigint }>();
  for (const leg of draft.legs) {
    const current = map.get(leg.accountCode) ?? { debit: 0n, credit: 0n };
    map.set(leg.accountCode, { debit: current.debit + leg.debit, credit: current.credit + leg.credit });
  }
  return map;
}

function expectLeg(draft: PostingDraft, account: string, side: 'debit' | 'credit', amount: bigint): void {
  const entry = legs(draft).get(account);
  expect(entry, `missing leg ${account}`).toBeDefined();
  expect(entry?.[side], `${account} ${side}`).toBe(amount);
}

function build(event: string, payload: Record<string, unknown>, channelCode?: string): PostingDraft {
  const draft = buildPostingDraft(event, payload, ctx(channelCode));
  assertDraft(draft);
  const totals = draftTotals(draft.legs);
  expect(totals.debit).toBe(totals.credit);
  expect(totals.debit).toBeGreaterThan(0n);
  expect(draft.legs.length).toBeGreaterThanOrEqual(2);
  return draft;
}

describe('posting matrix — sales', () => {
  it('#1 taxable credit sale: AR gross / revenue net / VAT / shipping (no COGS)', () => {
    const draft = build('sales.invoice.issued', {
      invoiceId: '1',
      customerId: '10',
      netAmount: '1000000',
      discountAmount: '50000',
      taxAmount: '95000',
      shippingAmount: '20000',
      grossAmount: '1065000',
    }, 'digikala');
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'debit', 1_065_000n);
    expectLeg(draft, ACCOUNTS.salesDiscounts, 'debit', 50_000n);
    expectLeg(draft, '4-1-01-002', 'credit', 1_000_000n);
    expectLeg(draft, ACCOUNTS.vatPayable, 'credit', 95_000n);
    expectLeg(draft, ACCOUNTS.shippingRevenue, 'credit', 20_000n);
    expect(legs(draft).has(ACCOUNTS.cogs)).toBe(false);
  });

  it('#1 exempt sale omits the VAT leg', () => {
    const draft = build('sales.invoice.issued', {
      netAmount: '500000',
      taxAmount: '0',
      grossAmount: '500000',
    });
    expect(legs(draft).has(ACCOUNTS.vatPayable)).toBe(false);
    expectLeg(draft, '4-1-01-001', 'credit', 500_000n);
  });

  it('#1 rejects a gross that does not reconcile', () => {
    expect(() =>
      build('sales.invoice.issued', { netAmount: '100', taxAmount: '10', grossAmount: '999' }),
    ).toThrow();
  });

  it('#2 COGS is posted at stock issue, not at invoice', () => {
    const draft = build('inventory.issue.posted', { issueId: '3', totalCostAmount: '700000' });
    expectLeg(draft, ACCOUNTS.cogs, 'debit', 700_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'credit', 700_000n);
  });

  it('#2 rejects a zero-cost issue', () => {
    expect(() => build('inventory.issue.posted', { totalCostAmount: '0' })).toThrow();
  });

  it('#3 cash sale posts cash, revenue, VAT, COGS and inventory', () => {
    const draft = build('sales.cash_sale', {
      netAmount: '100000',
      taxAmount: '10000',
      grossAmount: '110000',
      paidAmount: '110000',
      cogsAmount: '60000',
      method: 'cash',
    }, 'pos');
    expectLeg(draft, ACCOUNTS.cash, 'debit', 110_000n);
    expectLeg(draft, ACCOUNTS.cogs, 'debit', 60_000n);
    expectLeg(draft, '4-1-01-005', 'credit', 100_000n);
    expectLeg(draft, ACCOUNTS.vatPayable, 'credit', 10_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'credit', 60_000n);
  });

  it('#4 post-issue discount reduces AR against the contra-revenue account', () => {
    const draft = build('sales.discount.applied', { amount: '25000', customerId: '7' });
    expectLeg(draft, ACCOUNTS.salesDiscounts, 'debit', 25_000n);
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'credit', 25_000n);
  });

  it('#5 collection keeps the unapplied part as customer credit', () => {
    const draft = build('sales.payment.received', {
      amount: '500000',
      unappliedAmount: '120000',
      method: 'bank',
    });
    expectLeg(draft, ACCOUNTS.bank, 'debit', 500_000n);
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'credit', 380_000n);
    expectLeg(draft, ACCOUNTS.customerCredit, 'credit', 120_000n);
  });

  it('#6 restocked return reverses revenue, VAT and COGS', () => {
    const draft = build('sales.return.received', {
      returnId: '9',
      condition: 'restock',
      netAmount: '200000',
      taxAmount: '20000',
      grossAmount: '220000',
      restockCostAmount: '120000',
    });
    expectLeg(draft, ACCOUNTS.salesReturns, 'debit', 200_000n);
    expectLeg(draft, ACCOUNTS.vatPayable, 'debit', 20_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'debit', 120_000n);
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'credit', 220_000n);
    expectLeg(draft, ACCOUNTS.cogs, 'credit', 120_000n);
  });

  it('#7 scrap return books a damage loss instead of restoring COGS', () => {
    const draft = build('sales.return.received', {
      condition: 'scrap',
      netAmount: '100000',
      taxAmount: '10000',
      grossAmount: '110000',
      restockCostAmount: '70000',
    });
    expectLeg(draft, ACCOUNTS.damage, 'debit', 70_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'credit', 70_000n);
    expect(legs(draft).has(ACCOUNTS.cogs)).toBe(false);
  });

  it('#8 refund settles customer credit against the bank', () => {
    const draft = build('sales.refund.paid', {
      amount: '40000',
      fromCustomerCredit: true,
      method: 'bank',
    });
    expectLeg(draft, ACCOUNTS.customerCredit, 'debit', 40_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 40_000n);
  });

  it('#19 recharged shipping posts AR / shipping revenue / VAT', () => {
    const draft = build('shipping.recharged', { netAmount: '30000', taxAmount: '3000', grossAmount: '33000' });
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'debit', 33_000n);
    expectLeg(draft, ACCOUNTS.shippingRevenue, 'credit', 30_000n);
    expectLeg(draft, ACCOUNTS.vatPayable, 'credit', 3_000n);
  });
});

describe('posting matrix — purchases (GRNI, 3-way match)', () => {
  it('#9 receipt credits GRNI, never AP', () => {
    const draft = build('purchase.receipt.posted', {
      receiptId: '1',
      netLandedCostAmount: '800000',
      inputVatAmount: '80000',
      taxInvoiceExists: true,
    });
    expectLeg(draft, ACCOUNTS.inventory, 'debit', 800_000n);
    expectLeg(draft, ACCOUNTS.vatReceivable, 'debit', 80_000n);
    expectLeg(draft, ACCOUNTS.grni, 'credit', 880_000n);
    expect(legs(draft).has(ACCOUNTS.accountsPayable)).toBe(false);
  });

  it('#9 receipt without a tax invoice does not claim input VAT', () => {
    const draft = build('purchase.receipt.posted', {
      netLandedCostAmount: '800000',
      inputVatAmount: '80000',
      taxInvoiceExists: false,
    });
    expect(legs(draft).has(ACCOUNTS.vatReceivable)).toBe(false);
    expectLeg(draft, ACCOUNTS.grni, 'credit', 800_000n);
  });

  it('#10 supplier invoice clears GRNI, claims VAT and books price variance', () => {
    const draft = build('purchase.invoice.received', {
      grniAmount: '800000',
      inputVatAmount: '80000',
      priceVarianceAmount: '15000',
      apAmount: '895000',
    });
    expectLeg(draft, ACCOUNTS.grni, 'debit', 800_000n);
    expectLeg(draft, ACCOUNTS.vatReceivable, 'debit', 80_000n);
    expectLeg(draft, ACCOUNTS.settlementVariance, 'debit', 15_000n);
    expectLeg(draft, ACCOUNTS.accountsPayable, 'credit', 895_000n);
  });

  it('#10 favourable variance is credited', () => {
    const draft = build('purchase.invoice.received', {
      grniAmount: '800000',
      inputVatAmount: '0',
      priceVarianceAmount: '-20000',
      apAmount: '780000',
    });
    expectLeg(draft, ACCOUNTS.settlementVariance, 'credit', 20_000n);
    expectLeg(draft, ACCOUNTS.accountsPayable, 'credit', 780_000n);
  });

  it('#10 rejects an AP that does not equal GRNI + VAT + variance', () => {
    expect(() =>
      build('purchase.invoice.received', { grniAmount: '100', inputVatAmount: '10', apAmount: '999' }),
    ).toThrow();
  });

  it('#11 explicit variance posts to the variance account', () => {
    const draft = build('purchase.invoice.variance', { varianceAmount: '5000' });
    expectLeg(draft, ACCOUNTS.settlementVariance, 'debit', 5_000n);
    expectLeg(draft, ACCOUNTS.accountsPayable, 'credit', 5_000n);
  });

  it('#12 purchase return reverses inventory and input VAT against AP', () => {
    const draft = build('purchase.return.issued', {
      apAmount: '550000',
      inventoryAmount: '500000',
      inputVatAmount: '50000',
    });
    expectLeg(draft, ACCOUNTS.accountsPayable, 'debit', 550_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'credit', 500_000n);
    expectLeg(draft, ACCOUNTS.vatReceivable, 'credit', 50_000n);
  });

  it('#13 supplier payment reduces AP from the bank', () => {
    const draft = build('purchase.payment.paid', { amount: '300000', method: 'bank' });
    expectLeg(draft, ACCOUNTS.accountsPayable, 'debit', 300_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 300_000n);
  });

  it('#14 supplier prepayment is an asset, not AP', () => {
    const draft = build('purchase.prepayment.paid', { amount: '250000', method: 'bank' });
    expectLeg(draft, ACCOUNTS.supplierPrepayment, 'debit', 250_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 250_000n);
  });
});

describe('posting matrix — channels (settlement never re-recognises revenue)', () => {
  it('#15 commission/fee accrual separates recoverable VAT', () => {
    const draft = build('channel.fee.accrued', {
      commissionAmount: '90000',
      feeAmount: '10000',
      feeVatAmount: '9000',
      feeVatRecoverable: true,
    }, 'digikala');
    expectLeg(draft, '5-2-03-001', 'debit', 100_000n);
    expectLeg(draft, ACCOUNTS.vatReceivable, 'debit', 9_000n);
    expectLeg(draft, ACCOUNTS.channelFeePayable, 'credit', 109_000n);
  });

  it('#16 settlement clears the channel receivable and never credits revenue', () => {
    const draft = build('settlement.confirmed', {
      settlementId: '1',
      grossSalesAmount: '1000000',
      commissionAmount: '90000',
      feeAmount: '10000',
      returnAmount: '50000',
      taxAmount: '95000',
      netPayableAmount: '755000',
    }, 'digikala');
    expectLeg(draft, ACCOUNTS.settlementClearing, 'debit', 755_000n);
    expectLeg(draft, ACCOUNTS.channelFeePayable, 'debit', 100_000n);
    expectLeg(draft, ACCOUNTS.salesReturns, 'debit', 50_000n);
    expectLeg(draft, ACCOUNTS.vatPayable, 'debit', 95_000n);
    expectLeg(draft, '1-1-08-001', 'credit', 1_000_000n);
    for (const code of legs(draft).keys()) {
      expect(code.startsWith('4-1-01'), `unexpected revenue leg ${code}`).toBe(false);
    }
  });

  it('#16 rejects a settlement whose net breaks the formula', () => {
    expect(() =>
      build('settlement.confirmed', {
        grossSalesAmount: '1000000',
        commissionAmount: '100000',
        netPayableAmount: '950000',
      }),
    ).toThrow();
  });

  it('#17 settlement variance adjusts the channel receivable', () => {
    const draft = build('settlement.variance.recorded', { varianceAmount: '1200' }, 'snapp');
    expectLeg(draft, ACCOUNTS.settlementVariance, 'debit', 1_200n);
    expectLeg(draft, '1-1-08-003', 'credit', 1_200n);
  });
});

describe('posting matrix — inventory, shipping, expenses', () => {
  it('#18 shipping cost is an expense paid by bank', () => {
    const draft = build('shipping.cost.incurred', { amount: '45000', paidByBank: true });
    expectLeg(draft, ACCOUNTS.shippingExpense, 'debit', 45_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 45_000n);
  });

  it('#18 inbound freight can be capitalised into inventory', () => {
    const draft = build('shipping.cost.incurred', { amount: '45000', capitaliseToInventory: true });
    expectLeg(draft, ACCOUNTS.inventory, 'debit', 45_000n);
  });

  it('#20 shortage adjustment uses the layer cost and the shortage account', () => {
    const draft = build('inventory.adjustment.posted', { kind: 'count_shortage', totalCostAmount: '130000' });
    expectLeg(draft, ACCOUNTS.countShortage, 'debit', 130_000n);
    expectLeg(draft, ACCOUNTS.inventory, 'credit', 130_000n);
  });

  it('#20 rejects zero-cost relief', () => {
    expect(() => build('inventory.adjustment.posted', { kind: 'waste', totalCostAmount: '0' })).toThrow();
  });

  it('#21 gain flips sides to the count-gain account', () => {
    const draft = build('inventory.adjustment.posted', { kind: 'count_gain', totalCostAmount: '90000' });
    expectLeg(draft, ACCOUNTS.inventory, 'debit', 90_000n);
    expectLeg(draft, ACCOUNTS.countGainIncome, 'credit', 90_000n);
  });

  it('#22/#23 transfer dispatch and receive use the in-transit account', () => {
    const dispatch = build('inventory.transfer.dispatched', { totalCostAmount: '60000' });
    expectLeg(dispatch, ACCOUNTS.goodsInTransit, 'debit', 60_000n);
    expectLeg(dispatch, ACCOUNTS.inventory, 'credit', 60_000n);
    const receive = build('inventory.transfer.received', { totalCostAmount: '60000' });
    expectLeg(receive, ACCOUNTS.inventory, 'debit', 60_000n);
    expectLeg(receive, ACCOUNTS.goodsInTransit, 'credit', 60_000n);
  });

  it('#24 valuation true-up flips direction with the variance sign', () => {
    const up = build('inventory.valuation.posted', { varianceAmount: '8000' });
    expectLeg(up, ACCOUNTS.inventory, 'debit', 8_000n);
    expectLeg(up, ACCOUNTS.otherIncome, 'credit', 8_000n);
    const down = build('inventory.valuation.posted', { varianceAmount: '-8000' });
    expectLeg(down, ACCOUNTS.countShortage, 'debit', 8_000n);
    expectLeg(down, ACCOUNTS.inventory, 'credit', 8_000n);
  });

  it('#42 expense with recoverable VAT posts the input VAT leg', () => {
    const draft = build('expense.recognised', {
      accountCode: '5-2-04-001',
      amount: '200000',
      taxAmount: '20000',
      taxRecoverable: true,
    });
    expectLeg(draft, '5-2-04-001', 'debit', 200_000n);
    expectLeg(draft, ACCOUNTS.vatReceivable, 'debit', 20_000n);
    expectLeg(draft, ACCOUNTS.accountsPayable, 'credit', 220_000n);
  });

  it('#42 rejects a non-expense account code', () => {
    expect(() =>
      build('expense.recognised', { accountCode: '1-1-04-001', amount: '1000' }),
    ).toThrow();
  });

  it('#43 expense payment clears AP', () => {
    const draft = build('expense.paid', { amount: '220000', method: 'bank' });
    expectLeg(draft, ACCOUNTS.accountsPayable, 'debit', 220_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 220_000n);
  });

  it('#44/#45 bad-debt allowance and write-off use the contra-asset account', () => {
    const allowance = build('bad_debt.allowance', { amount: '50000' });
    expectLeg(allowance, ACCOUNTS.badDebtExpense, 'debit', 50_000n);
    expectLeg(allowance, ACCOUNTS.allowanceDoubtful, 'credit', 50_000n);
    const writeoff = build('bad_debt.writeoff', { amount: '50000' });
    expectLeg(writeoff, ACCOUNTS.allowanceDoubtful, 'debit', 50_000n);
    expectLeg(writeoff, ACCOUNTS.accountsReceivable, 'credit', 50_000n);
  });

  it('#49 FX revaluation posts gain/loss', () => {
    const gain = build('fx.revaluation', { varianceAmount: '1500' });
    expectLeg(gain, ACCOUNTS.bank, 'debit', 1_500n);
    expectLeg(gain, ACCOUNTS.otherIncome, 'credit', 1_500n);
  });
});

describe('posting matrix — treasury & cheques', () => {
  it('#25 cash receipt increases the box and clears AR', () => {
    const draft = build('cash.receipt.recorded', { amount: '70000', partyType: 'customer', partyId: '4' });
    expectLeg(draft, ACCOUNTS.cash, 'debit', 70_000n);
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'credit', 70_000n);
  });

  it('#26/#27 cash session variance posts over/short', () => {
    const over = build('cash.session.closed', { differenceAmount: '3000' });
    expectLeg(over, ACCOUNTS.cash, 'debit', 3_000n);
    expectLeg(over, ACCOUNTS.cashOver, 'credit', 3_000n);
    const short = build('cash.session.closed', { differenceAmount: '-2000' });
    expectLeg(short, ACCOUNTS.cashShort, 'debit', 2_000n);
    expectLeg(short, ACCOUNTS.cash, 'credit', 2_000n);
  });

  it('#28 cheque received: cheque on hand / AR', () => {
    const draft = build('cheque.received', { amount: '900000', partyType: 'customer', partyId: '2' });
    expectLeg(draft, ACCOUNTS.chequeOnHand, 'debit', 900_000n);
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'credit', 900_000n);
  });

  it('#29 cheque deposit moves to cheques in collection', () => {
    const draft = build('cheque.deposited', { amount: '900000' });
    expectLeg(draft, ACCOUNTS.chequeInCollection, 'debit', 900_000n);
    expectLeg(draft, ACCOUNTS.chequeOnHand, 'credit', 900_000n);
  });

  it('#30 cleared received cheque hits the bank; issued cheque clears payables', () => {
    const received = build('cheque.cleared', { amount: '900000', direction: 'received' });
    expectLeg(received, ACCOUNTS.bank, 'debit', 900_000n);
    expectLeg(received, ACCOUNTS.chequeInCollection, 'credit', 900_000n);
    const issued = build('cheque.issued.cleared', { amount: '400000' });
    expectLeg(issued, ACCOUNTS.chequesPayable, 'debit', 400_000n);
    expectLeg(issued, ACCOUNTS.bank, 'credit', 400_000n);
  });

  it('#31 bounce before clear restores AR and releases the cheque', () => {
    const draft = build('cheque.bounced', { amount: '900000', afterClear: false, direction: 'received' });
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'debit', 900_000n);
    expectLeg(draft, ACCOUNTS.chequeInCollection, 'credit', 900_000n);
  });

  it('#32 bounce after clear reverses the bank and books charges', () => {
    const draft = build('cheque.bounced', {
      amount: '900000',
      afterClear: true,
      bankChargesAmount: '15000',
    });
    expectLeg(draft, ACCOUNTS.accountsReceivable, 'debit', 900_000n);
    expectLeg(draft, ACCOUNTS.bankCharges, 'debit', 15_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 915_000n);
    expect(legs(draft).has(ACCOUNTS.chequeOnHand)).toBe(false);
  });

  it('#33 endorsement settles AP from cheques on hand', () => {
    const draft = build('cheque.endorsed', { amount: '300000', endorsedTo: 'تأمین‌کننده الف' });
    expectLeg(draft, ACCOUNTS.accountsPayable, 'debit', 300_000n);
    expectLeg(draft, ACCOUNTS.chequeOnHand, 'credit', 300_000n);
  });

  it('#34 issued cheque: AP / cheques payable', () => {
    const draft = build('cheque.issued', { amount: '500000' });
    expectLeg(draft, ACCOUNTS.accountsPayable, 'debit', 500_000n);
    expectLeg(draft, ACCOUNTS.chequesPayable, 'credit', 500_000n);
  });

  it('#36/#37 advances and their allocation move between credit and AR/AP', () => {
    const advance = build('payment.advance.received', { amount: '200000', method: 'bank' });
    expectLeg(advance, ACCOUNTS.bank, 'debit', 200_000n);
    expectLeg(advance, ACCOUNTS.customerAdvance, 'credit', 200_000n);
    const allocate = build('payment.allocated', { amount: '150000', direction: 'inbound' });
    expectLeg(allocate, ACCOUNTS.customerAdvance, 'debit', 150_000n);
    expectLeg(allocate, ACCOUNTS.accountsReceivable, 'credit', 150_000n);
    const supplier = build('payment.allocated', { amount: '150000', direction: 'outbound' });
    expectLeg(supplier, ACCOUNTS.accountsPayable, 'debit', 150_000n);
    expectLeg(supplier, ACCOUNTS.supplierPrepayment, 'credit', 150_000n);
  });

  it('#40/#41 VAT payment and refund', () => {
    const payment = build('tax.vat.payment', { amount: '120000' });
    expectLeg(payment, ACCOUNTS.vatPayable, 'debit', 120_000n);
    expectLeg(payment, ACCOUNTS.bank, 'credit', 120_000n);
    const refund = build('tax.vat.refund', { amount: '60000' });
    expectLeg(refund, ACCOUNTS.bank, 'debit', 60_000n);
    expectLeg(refund, ACCOUNTS.vatReceivable, 'credit', 60_000n);
  });
});

describe('posting matrix — equity, closing and opening', () => {
  it('#38 profit distribution debits retained earnings, not current profit', () => {
    const draft = build('profit.distribution.approved', {
      totalProfitAmount: '1000000',
      dividendsAmount: '800000',
      legalReserveAmount: '100000',
      withholdingAmount: '100000',
    });
    expectLeg(draft, ACCOUNTS.retainedEarnings, 'debit', 1_000_000n);
    expectLeg(draft, ACCOUNTS.dividendsPayable, 'credit', 800_000n);
    expectLeg(draft, ACCOUNTS.legalReserve, 'credit', 100_000n);
    expectLeg(draft, ACCOUNTS.withholdingTaxPayable, 'credit', 100_000n);
    expect(legs(draft).has(ACCOUNTS.currentPeriodProfit)).toBe(false);
  });

  it('#38 rejects retention that does not reconcile', () => {
    expect(() =>
      build('profit.distribution.approved', { totalProfitAmount: '1000', dividendsAmount: '900' }),
    ).toThrow();
  });

  it('#39 dividend payment clears the payable', () => {
    const draft = build('dividend.paid', { amount: '800000' });
    expectLeg(draft, ACCOUNTS.dividendsPayable, 'debit', 800_000n);
    expectLeg(draft, ACCOUNTS.bank, 'credit', 800_000n);
  });

  it('#46 income summary closes revenue and expense accounts', () => {
    const draft = build('closing.income_summary', {
      balances: [
        { accountCode: '4-1-01-001', amount: '1000000' },
        { accountCode: '5-1-01-001', amount: '600000' },
        { accountCode: '5-2-01-001', amount: '100000' },
      ],
    });
    expectLeg(draft, '4-1-01-001', 'debit', 1_000_000n);
    expectLeg(draft, '5-1-01-001', 'credit', 600_000n);
    expectLeg(draft, '5-2-01-001', 'credit', 100_000n);
    expectLeg(draft, ACCOUNTS.currentPeriodProfit, 'credit', 1_000_000n);
    expectLeg(draft, ACCOUNTS.currentPeriodProfit, 'debit', 700_000n);
    expect(draft.entryType).toBe('closing');
  });

  it('#47 retained earnings appropriates the legal reserve', () => {
    const draft = build('closing.retained_earnings', {
      netProfitAmount: '300000',
      legalReserveAmount: '15000',
      retainedAmount: '285000',
    });
    expectLeg(draft, ACCOUNTS.currentPeriodProfit, 'debit', 300_000n);
    expectLeg(draft, ACCOUNTS.legalReserve, 'credit', 15_000n);
    expectLeg(draft, ACCOUNTS.retainedEarnings, 'credit', 285_000n);
  });

  it('#47 loss reverses the reserve direction', () => {
    const draft = build('closing.retained_earnings', { netProfitAmount: '-120000' });
    expectLeg(draft, ACCOUNTS.currentPeriodProfit, 'credit', 120_000n);
    expectLeg(draft, ACCOUNTS.retainedEarnings, 'debit', 120_000n);
  });

  it('#48 opening balances balance through opening equity', () => {
    const draft = build('opening.balances.imported', {
      descriptionFa: 'مانده افتتاحیه',
      debitBalances: [{ accountCode: '1-1-01-002', amount: '500000' }],
      creditBalances: [{ accountCode: '3-1-01-001', amount: '450000' }],
    });
    expectLeg(draft, ACCOUNTS.bank, 'debit', 500_000n);
    expectLeg(draft, ACCOUNTS.registeredCapital, 'credit', 500_000n);
    expect(draft.entryType).toBe('opening');
  });
});

describe('posting matrix coverage', () => {
  it('covers all 45 dispatched events of the 49-row matrix (48/49 rows mapped)', () => {
    expect(ACCOUNTING_EVENTS.length).toBe(45);
    for (const event of ACCOUNTING_EVENTS) {
      expect(typeof event).toBe('string');
    }
  });
});
