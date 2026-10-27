/**
 * TD-19 — closed financial period must reject posting.
 *
 * Regression this locks in: the endpoint used to accept `{ postDate }` in the body
 * and resolve the period from that caller-supplied date, so a draft whose stored
 * date sat in a closed period could be posted by passing a date in an open
 * period. The service now resolves the period from the persisted entry date and
 * does it inside the posting transaction (period row locked `FOR UPDATE`).
 */
import { describe, it } from 'node:test';

import { expect } from './support/expect';
import { AppError } from '@saman/shared';

import type { TenantContext } from '../src/common/contracts';
import { JournalService } from '../src/modules/accounting/journal/journal.service';
import type { JournalRecord } from '../src/modules/accounting/journal/journal.repository';

const ENTRY_DATE = '2026-05-10';
const OPEN_DATE_PASSED_IN_BODY = '2026-06-01';

const ctx: TenantContext = {
  requestId: '11111111-1111-4111-8111-111111111111',
  orgId: 1n,
  orgPublicId: '22222222-2222-4222-8222-222222222222',
  actorId: 7n,
  actorPublicId: '33333333-3333-4333-8333-333333333333',
  permissions: [],
  branchIds: null,
  warehouseIds: null,
};

function entry(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: 42n,
    publicId: '44444444-4444-4444-8444-444444444444',
    organizationId: 1n,
    entryNo: null,
    entryDate: ENTRY_DATE,
    entryType: 'normal',
    status: 'approved',
    description: 'synthetic',
    fiscalYearId: 3n,
    periodId: 5n,
    totalDebitAmount: 100n,
    totalCreditAmount: 100n,
    sourceType: null,
    sourceId: null,
    reversalOfId: null,
    postingRuleSetId: null,
    postedAt: null,
    createdBy: 9n,
    version: 1,
    lines: [
      { id: 1n, lineNo: 1, accountId: 10n, accountCode: '1-1-01-001', debitAmount: 100n, creditAmount: 0n, description: null, partnerType: null, partnerId: null },
      { id: 2n, lineNo: 2, accountId: 11n, accountCode: '2-1-01-001', debitAmount: 0n, creditAmount: 100n, description: null, partnerType: null, partnerId: null },
    ],
    ...overrides,
  };
}

interface HarnessOptions {
  readonly periodStatus: string;
  readonly resolvedPeriodId?: bigint;
  readonly yearStatus?: string;
}

function harness(options: HarnessOptions) {
  const calls = {
    resolveDates: [] as string[],
    assignedPeriod: null as null | { periodId: bigint; fiscalYearId: bigint },
    balancesPeriodId: null as bigint | null,
    statusSet: false,
  };

  const tx = Object.assign(
    (): Promise<unknown[]> => Promise.resolve([]),
    { unsafe: (): Promise<unknown[]> => Promise.resolve([]) },
  );

  const repo = {
    findById: async (): Promise<JournalRecord> => entry(),
    allocateEntryNo: async (): Promise<string> => 'JV-1405-000001',
    setEntryNo: async (): Promise<void> => undefined,
    updateTotals: async (): Promise<void> => undefined,
    setStatus: async (): Promise<void> => {
      calls.statusSet = true;
    },
    assignPeriod: async (_tx: unknown, _id: bigint, periodId: bigint, fiscalYearId: bigint): Promise<void> => {
      calls.assignedPeriod = { periodId, fiscalYearId };
    },
    applyBalances: async (_tx: unknown, input: { periodId: bigint }): Promise<void> => {
      calls.balancesPeriodId = input.periodId;
    },
  };

  const calendar = {
    resolveAndLockPeriod: async (_tx: unknown, _orgId: bigint, date: string) => {
      calls.resolveDates.push(date);
      return {
        period: {
          id: options.resolvedPeriodId ?? 6n,
          publicId: '55555555-5555-4555-8555-555555555555',
          fiscalYearId: 3n,
          periodNo: 2,
          nameFa: 'اردیبهشت ۱۴۰۵',
          startDate: '2026-04-21',
          endDate: '2026-05-21',
          status: options.periodStatus,
          closedAt: options.periodStatus === 'open' ? null : '2026-06-01T00:00:00Z',
        },
        year: {
          id: 3n,
          publicId: '66666666-6666-4666-8666-666666666666',
          organizationId: 1n,
          code: '1405',
          title: '۱۴۰۵',
          startDate: '2026-03-21',
          endDate: '2027-03-20',
          status: options.yearStatus ?? 'open',
          closedAt: null,
          closingRunId: null,
          version: 1,
        },
      };
    },
  };

  const db = {
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  };

  const audit = { record: async (): Promise<void> => undefined };
  const events = { emit: async (): Promise<void> => undefined };

  const service = new JournalService(
    repo as never,
    {} as never,
    calendar as never,
    db as never,
    audit as never,
    events as never,
  );

  return { service, calls };
}

describe('JournalService.post — TD-19 closed period', () => {
  it('rejects posting a stored entry whose period is closed, even when the body passes an open-period date', async () => {
    const { service, calls } = harness({ periodStatus: 'closed' });

    let thrown: unknown;
    try {
      // The endpoint may still receive a different date in the body; it must be ignored.
      await service.post(ctx, 42n, OPEN_DATE_PASSED_IN_BODY);
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof AppError).toBe(true);
    expect((thrown as AppError).code).toBe('PERIOD_CLOSED');
    // Period resolution used the persisted entry date only.
    expect(calls.resolveDates).toEqual([ENTRY_DATE]);
    expect(calls.statusSet).toBe(false);
  });

  it('rejects a locked period and a closed fiscal year', async () => {
    const locked = harness({ periodStatus: 'locked' });
    let lockedError: unknown;
    try {
      await locked.service.post(ctx, 42n);
    } catch (error) {
      lockedError = error;
    }
    expect((lockedError as AppError).code).toBe('PERIOD_CLOSED');

    const closedYear = harness({ periodStatus: 'open', yearStatus: 'closed' });
    let yearError: unknown;
    try {
      await closedYear.service.post(ctx, 42n);
    } catch (error) {
      yearError = error;
    }
    expect((yearError as AppError).code).toBe('FISCAL_YEAR_CLOSED');
  });

  it('posts into the period derived from the stored date and re-points a stale draft period', async () => {
    const { service, calls } = harness({ periodStatus: 'open', resolvedPeriodId: 6n });
    const posted = await service.post(ctx, 42n, OPEN_DATE_PASSED_IN_BODY);

    expect(calls.resolveDates).toEqual([ENTRY_DATE]);
    expect(calls.assignedPeriod).toEqual({ periodId: 6n, fiscalYearId: 3n });
    expect(calls.balancesPeriodId).toBe(6n);
    expect(calls.statusSet).toBe(true);
    expect(posted.id).toBe(42n);
  });
});
