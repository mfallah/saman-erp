/** JSON serialisers: money leaves the API as integer strings (ADR-0013). */
import type { AccountRecord } from '../coa/chart-of-accounts.repository';
import type { JournalRecord } from '../journal/journal.repository';
import type { PeriodRecord, FiscalYearRecord } from '../periods/fiscal-calendar.repository';

export function moneyOut(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

export function accountOut(account: AccountRecord): Record<string, unknown> {
  return {
    id: account.publicId,
    code: account.code,
    nameFa: account.nameFa,
    nameEn: account.nameEn,
    level: account.accountLevel,
    parentId: account.parentId === null ? null : account.parentId.toString(),
    type: account.accountType,
    normalBalance: account.normalBalance,
    nature: account.nature,
    isPostable: account.isPostable,
    isActive: account.isActive,
    currency: account.currency,
    version: account.version,
  };
}

export function journalOut(journal: JournalRecord): Record<string, unknown> {
  return {
    id: journal.publicId,
    number: journal.entryNo,
    date: journal.entryDate,
    type: journal.entryType,
    status: journal.status,
    description: journal.description,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId === null ? null : journal.sourceId.toString(),
    reversalOfId: journal.reversalOfId === null ? null : journal.reversalOfId.toString(),
    postingRuleSetId: journal.postingRuleSetId === null ? null : journal.postingRuleSetId.toString(),
    totalDebit: moneyOut(journal.totalDebitAmount),
    totalCredit: moneyOut(journal.totalCreditAmount),
    postedAt: journal.postedAt,
    version: journal.version,
    lines: journal.lines.map((line) => ({
      id: line.id.toString(),
      lineNo: line.lineNo,
      accountId: line.accountId.toString(),
      accountCode: line.accountCode,
      debit: moneyOut(line.debitAmount),
      credit: moneyOut(line.creditAmount),
      description: line.description,
      partnerType: line.partnerType,
      partnerId: line.partnerId === null ? null : line.partnerId.toString(),
    })),
  };
}

export function fiscalYearOut(year: FiscalYearRecord): Record<string, unknown> {
  return {
    id: year.publicId,
    code: year.code,
    title: year.title,
    startDate: year.startDate,
    endDate: year.endDate,
    status: year.status,
    closedAt: year.closedAt,
    closingRunId: year.closingRunId === null ? null : year.closingRunId.toString(),
    version: year.version,
  };
}

export function periodOut(period: PeriodRecord): Record<string, unknown> {
  return {
    id: period.publicId,
    fiscalYearId: period.fiscalYearId.toString(),
    periodNo: period.periodNo,
    nameFa: period.nameFa,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
    closedAt: period.closedAt,
  };
}
