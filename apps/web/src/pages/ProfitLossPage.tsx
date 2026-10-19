import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatMoney, parseMoney, subtractMoney, sumMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import { useFiscalPeriodSelection } from '../lib/use-fiscal-periods';
import type { AccountBalanceRow } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { SkeletonText } from '../components/ui/Skeleton';

interface ProfitLossSection {
  readonly title: string;
  readonly rows: readonly AccountBalanceRow[];
  readonly total: bigint;
}

/** Income statement (سود و زیان) derived from account balances by account type. */
export function ProfitLossPage() {
  useDocumentTitle('سود و زیان');
  const canRead = useHasPermission(PERM.balanceRead);
  const selection = useFiscalPeriodSelection();

  const balancesQuery = useQuery({
    queryKey: queryKeys.accounting.accountBalances({
      fiscalYearId: selection.yearId,
      periodId: selection.periodId,
      view: 'profit-loss',
    }),
    queryFn: () =>
      api.getPage<AccountBalanceRow>('/accounting/account-balances', {
        perPage: 500,
        fiscalYearId: selection.yearId,
        ...(selection.periodId === '' ? {} : { periodId: selection.periodId }),
      }),
    enabled: canRead && selection.yearId !== '',
  });

  const sections = useMemo<readonly ProfitLossSection[]>(() => {
    const rows = balancesQuery.data?.items ?? [];
    const incomeRows = rows.filter((row) => row.account.type === 'income');
    const expenseRows = rows.filter((row) => row.account.type === 'expense');
    const incomeTotal = sumMoney(incomeRows.map((row) => subtractMoney(row.credit, row.debit)));
    const expenseTotal = sumMoney(expenseRows.map((row) => subtractMoney(row.debit, row.credit)));
    return [
      { title: 'درآمدها', rows: incomeRows, total: incomeTotal },
      { title: 'هزینه‌ها', rows: expenseRows, total: expenseTotal },
    ];
  }, [balancesQuery.data]);

  if (!canRead) {
    return (
      <>
        <PageHeader title="سود و زیان" />
        <PermissionNotice permission={PERM.balanceRead} />
      </>
    );
  }

  const incomeTotal = sections[0]?.total ?? 0n;
  const expenseTotal = sections[1]?.total ?? 0n;
  const netProfit = incomeTotal - expenseTotal;
  const rowsCount = (balancesQuery.data?.items ?? []).length;

  return (
    <>
      <PageHeader
        title="سود و زیان"
        description="خلاصه درآمدها و هزینه‌ها بر اساس مانده حساب‌های دفتر کل"
        breadcrumbs={[{ label: 'مالی' }, { label: 'سود و زیان' }]}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label htmlFor="pl-year" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            سال مالی
          </label>
          <Select
            id="pl-year"
            options={selection.years.map((year) => ({ value: year.id, label: year.title }))}
            value={selection.yearId}
            loading={selection.loading}
            placeholder="انتخاب سال مالی"
            onChange={(event) => selection.setYearId(event.target.value)}
          />
        </div>
        <div className="w-48">
          <label htmlFor="pl-period" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            دوره
          </label>
          <Select
            id="pl-period"
            options={[
              { value: '', label: 'کل سال' },
              ...selection.periods.map((period) => ({
                value: period.id,
                label: period.title ?? `${period.startDate ?? ''} تا ${period.endDate ?? ''}`,
              })),
            ]}
            value={selection.periodId}
            onChange={(event) => selection.setPeriodId(event.target.value)}
            disabled={selection.periods.length === 0}
          />
        </div>
      </div>

      {selection.yearId === '' && !selection.loading ? (
        <EmptyState
          icon={<TrendingUp className="size-9" />}
          title="سال مالی ثبت نشده است"
          description="برای محاسبه سود و زیان، ابتدا سال مالی و دوره‌های آن باید ایجاد شوند."
        />
      ) : balancesQuery.isError ? (
        <ErrorState error={balancesQuery.error} onRetry={() => void balancesQuery.refetch()} />
      ) : balancesQuery.isLoading || selection.loading ? (
        <SkeletonText lines={6} />
      ) : rowsCount === 0 ? (
        <EmptyState title="مانده‌ای برای این دوره ثبت نشده است" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {sections.map((section) => (
              <Card key={section.title} padding="none">
                <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{section.title}</h2>
                </div>
                {section.rows.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-500">موردی ثبت نشده است.</p>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      <tr>
                        <th scope="col" className="px-3 py-2 text-start">حساب</th>
                        <th scope="col" className="px-3 py-2 text-end">مبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((row) => {
                        const amount =
                          row.account.type === 'income'
                            ? subtractMoney(row.credit, row.debit)
                            : subtractMoney(row.debit, row.credit);
                        return (
                          <tr key={row.id ?? row.account.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                            <td className="px-3 py-2">
                              <span dir="ltr" className="me-2 text-xs text-slate-400">
                                {row.account.code}
                              </span>
                              {row.account.nameFa}
                            </td>
                            <td className="px-3 py-2 text-end tabular">{formatMoney(amount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-slate-50 font-semibold dark:bg-slate-800">
                      <tr>
                        <td className="px-3 py-2 text-end">جمع {section.title}</td>
                        <td className="px-3 py-2 text-end tabular">{formatMoney(section.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </Card>
            ))}
          </div>

          <div>
            <Card>
              <CardHeader title="نتیجه دوره" />
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1 text-slate-500">
                    <TrendingUp aria-hidden className="size-4 text-emerald-600" />
                    جمع درآمد
                  </span>
                  <span className="tabular font-medium">{formatMoney(incomeTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1 text-slate-500">
                    <TrendingDown aria-hidden className="size-4 text-red-600" />
                    جمع هزینه
                  </span>
                  <span className="tabular font-medium">{formatMoney(expenseTotal)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-sm dark:border-slate-700">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {netProfit >= 0n ? 'سود خالص' : 'زیان خالص'}
                  </span>
                  <span
                    className={`tabular font-bold ${netProfit >= 0n ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
                  >
                    {formatMoney(netProfit < 0n ? -netProfit : netProfit)}
                  </span>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-slate-400">
                محاسبه بر پایه مانده حساب‌های نوع «درآمد» و «هزینه» است؛ برای گزارش رسمی، گزارش income-statement را
                از بخش گزارش‌ها اجرا کنید.
              </p>
            </Card>
            {netProfit !== 0n && (
              <p className="mt-2 text-[11px] text-slate-400">
                مبالغ جمع‌شده:{' '}
                {formatMoney(parseMoney(incomeTotal) - parseMoney(expenseTotal))}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
