/**
 * Exact seeded account codes (`DATA-MODEL §6.3`) and the resolver keys used by
 * posting rules. No `00x` placeholder is ever produced: channel-specific
 * accounts resolve through `channelAccounts()` to the seeded L4 rows.
 */

export const ACCOUNTS = {
  // Assets
  bank: '1-1-01-002',
  cash: '1-1-01-003',
  gatewayClearing: '1-1-01-004',
  posClearing: '1-1-01-005',
  accountsReceivable: '1-1-03-001',
  notesReceivable: '1-1-03-002',
  allowanceDoubtful: '1-1-03-003',
  customerCredit: '1-1-03-004',
  inventory: '1-1-04-001',
  wipInventory: '1-1-04-002',
  supplierPrepayment: '1-1-05-001',
  employeeAdvance: '1-1-05-002',
  vatReceivable: '1-1-06-001',
  exportTaxCredit: '1-1-06-002',
  chequeOnHand: '1-1-07-001',
  chequeInCollection: '1-1-07-002',
  settlementClearing: '1-1-09-001',
  channelCashInTransit: '1-1-09-002',
  goodsInTransit: '1-1-10-001',
  goodsOnConsignment: '1-1-10-002',
  accumulatedDepreciation: '1-2-02-001',
  // Liabilities
  accountsPayable: '2-1-01-001',
  notesPayable: '2-1-01-002',
  payableToChannels: '2-1-01-003',
  vatPayable: '2-1-05-001',
  customerAdvance: '2-1-06-001',
  dividendsPayable: '2-1-08-001',
  chequesPayable: '2-1-09-001',
  channelFeePayable: '2-1-10-001',
  grni: '2-1-11-001',
  gatewaySettlementPayable: '2-1-12-001',
  withholdingTaxPayable: '2-1-13-001',
  // Equity
  registeredCapital: '3-1-01-001',
  uncalledCapital: '3-1-02-001',
  retainedEarnings: '3-2-01-001',
  legalReserve: '3-2-02-001',
  otherReserves: '3-2-03-001',
  currentPeriodProfit: '3-2-04-001',
  priorYearAdjustments: '3-2-05-001',
  // Income
  salesReturns: '4-1-02-001',
  salesDiscounts: '4-1-03-001',
  shippingRevenue: '4-1-04-001',
  cashOver: '4-2-02-001',
  otherIncome: '4-2-02-002',
  // Expenses
  cogs: '5-1-01-001',
  countShortage: '5-1-02-001',
  countGainIncome: '5-1-02-002',
  waste: '5-1-03-001',
  damage: '5-1-03-002',
  shippingExpense: '5-2-01-001',
  packagingExpense: '5-2-02-001',
  marketingExpense: '5-2-04-001',
  personnelExpense: '5-2-05-001',
  depreciationExpense: '5-2-06-001',
  bankCharges: '5-2-07-001',
  incomeTaxExpense: '5-2-08-001',
  rentExpense: '5-2-09-001',
  otherExpense: '5-2-10-001',
  badDebtExpense: '5-2-11-001',
  cashShort: '5-2-12-001',
  settlementVariance: '5-2-13-001',
  roundingDifference: '5-2-14-001',
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

export interface ChannelAccounts {
  /** Revenue account for the channel's sales (`4-1-01-00x`). */
  readonly sales: string;
  /** Channel receivable control account (`1-1-08-00x`). */
  readonly receivable: string;
  /** Commission/fee expense account (`5-2-03-00x`). */
  readonly feeExpense: string;
}

const CHANNEL_ACCOUNTS: Readonly<Record<string, ChannelAccounts>> = {
  carexy: { sales: '4-1-01-001', receivable: '1-1-08-002', feeExpense: '5-2-03-002' },
  digikala: { sales: '4-1-01-002', receivable: '1-1-08-001', feeExpense: '5-2-03-001' },
  snapp: { sales: '4-1-01-003', receivable: '1-1-08-003', feeExpense: '5-2-03-003' },
  tapsi: { sales: '4-1-01-004', receivable: '1-1-08-004', feeExpense: '5-2-03-003' },
  pos: { sales: '4-1-01-005', receivable: '1-1-03-001', feeExpense: '5-2-03-002' },
};

/**
 * Resolves channel-specific accounts. Unknown/absent channels fall back to the
 * generic site account, never to a wildcard (`R1-accounting` B-05).
 */
export function channelAccounts(channelCode: string | undefined): ChannelAccounts {
  const key = (channelCode ?? '').trim().toLowerCase();
  return CHANNEL_ACCOUNTS[key] ?? { sales: '4-1-01-001', receivable: '1-1-03-001', feeExpense: '5-2-03-002' };
}

/** Inventory loss account by adjustment kind (`H-05` separated accounts). */
export function adjustmentLossAccount(kind: string): string {
  switch (kind) {
    case 'damage':
      return ACCOUNTS.damage;
    case 'waste':
    case 'expiry':
    case 'scrap':
      return ACCOUNTS.waste;
    case 'count_shortage':
    case 'shortage':
    default:
      return ACCOUNTS.countShortage;
  }
}

/** Cash/bank/clearing account for a payment method. */
export function methodAccount(
  method: string,
  accounts: { readonly bankAccountCode?: string; readonly cashAccountCode?: string } = {},
): string {
  switch (method) {
    case 'cash':
      return accounts.cashAccountCode ?? ACCOUNTS.cash;
    case 'bank':
    case 'bank_transfer':
      return accounts.bankAccountCode ?? ACCOUNTS.bank;
    case 'gateway':
      return ACCOUNTS.gatewayClearing;
    case 'pos':
    case 'card':
      return ACCOUNTS.posClearing;
    case 'cash_on_delivery':
    case 'cod':
      return ACCOUNTS.gatewayClearing;
    case 'cheque':
      return ACCOUNTS.chequeOnHand;
    default:
      return ACCOUNTS.bank;
  }
}

/**
 * Validates that an operator-supplied account code is an L4+ postable expense
 * account. Rules accept explicit codes only for expense posting; every other
 * account is fixed or resolved by the engine.
 */
export function isExpenseAccountCode(code: string): boolean {
  return /^5-\d{1,2}-\d{2}-\d{3}$/.test(code);
}
