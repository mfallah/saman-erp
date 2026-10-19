import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { api } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatMoney, sumMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import { useFiscalPeriodSelection } from '../lib/use-fiscal-periods';
import type { AccountBalanceRow } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { SkeletonText } from '../components/ui/Skeleton';

/** Trial balance built from the server-side account balance projection. */
export function TrialBalancePage() {
  useDocumentTitle('تراز آزمایشی');
  const canRead = useHasPermission(PERM.balanceRead);
  const selection = useFiscalPeriodSelection();

  const balancesQuery = useQuery({
    queryKey: queryKeys.accounting.accountBalances({
      fiscalYearId: selection.yearId,
      periodId: selection.periodId,
    }),
    queryFn: () =>
      api.getPage<AccountBalanceRow>('/accounting/account-balances', {
        perPage: 500,
        fiscalYearId: selection.yearId,
        ...(selection.periodId === '' ? {} : { periodId: selection.periodId }),
      }),
    enabled: canRead && selection.yearId !== '',
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="تراز آزمایشی" />
        <PermissionNotice permission={PERM.balanceRead} />
      </>
    );
  }

  const rows = balancesQuery.data?.items ?? [];
  const totalDebit = sumMoney(rows.map((row) => row.debit));
  const totalCredit = sumMoney(rows.map((row) => row.credit));
  const balanced = totalDebit === totalCredit;

  return (
    <>
      <PageHeader
        title="تراز آزمایشی"
        description="مانده بدهکار و بستانکار حساب‌ها بر اساس دفتر کل"
        breadcrumbs={[{ label: 'مالی' }, { label: 'تراز آزمایشی' }]}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label htmlFor="tb-year" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            سال مالی
          </label>
          <Select
            id="tb-year"
            options={selection.years.map((year) => ({ value: year.id, label: year.title }))}
            value={selection.yearId}
            loading={selection.loading}
            placeholder="انتخاب سال مالی"
            onChange={(event) => selection.setYearId(event.target.value)}
          />
        </div>
        <div className="w-48">
          <label htmlFor="tb-period" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            دوره
          </label>
          <Select
            id="tb-period"
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
        {selection.error !== null && selection.error !== undefined && (
          <ErrorState message="دریافت سال‌های مالی ناموفق بود." onRetry={selection.refetch} />
        )}
      </div>

      {selection.yearId === '' && !selection.loading ? (
        <EmptyState
          icon={<Scale className="size-9" />}
          title="سال مالی ثبت نشده است"
          description="برای مشاهده تراز آزمایشی، ابتدا سال مالی و دوره‌های آن باید در سامانه ایجاد شوند."
        />
      ) : balancesQuery.isError ? (
        <ErrorState error={balancesQuery.error} onRetry={() => void balancesQuery.refetch()} />
      ) : balancesQuery.isLoading || selection.loading ? (
        <SkeletonText lines={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="مانده‌ای برای این دوره ثبت نشده است" />
      ) : (
        <>
          <Card padding="none">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start">کد حساب</th>
                    <th scope="col" className="px-3 py-2 text-start">نام حساب</th>
                    <th scope="col" className="px-3 py-2 text-end">بدهکار</th>
                    <th scope="col" className="px-3 py-2 text-end">بستانکار</th>
                    <th scope="col" className="px-3 py-2 text-end">مانده</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={row.id ?? `${row.account.id}-${index}`}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    >
                      <td dir="ltr" className="px-3 py-2 text-start font-medium">
                        {row.account.code}
                      </td>
                      <td className="px-3 py-2">{row.account.nameFa}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(row.debit)}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(row.credit)}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(row.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-semibold dark:bg-slate-800">
                  <tr>
                    <td colSpan={2} className="px-3 py-2 text-end">
                      جمع کل
                    </td>
                    <td className="px-3 py-2 text-end tabular">{formatMoney(totalDebit)}</td>
                    <td className="px-3 py-2 text-end tabular">{formatMoney(totalCredit)}</td>
                    <td className="px-3 py-2 text-end">
                      {balanced ? <Badge tone="success">متوازن</Badge> : <Badge tone="danger">نامتوازن</Badge>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
          <p className="mt-3 text-[11px] text-slate-400">
            جمع‌ها در سمت کلاینت با اعداد صحیح ({'>'}bigint) محاسبه می‌شوند؛ مبالغ از سرور به‌صورت رشته دریافت
            می‌شوند.
          </p>
        </>
      )}

      <div className="mt-4">
        <Card>
          <CardHeader title="راهنما" />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            تراز آزمایشی از جمع مانده حساب‌ها در دفتر کل تولید می‌شود. اگر جمع بدهکار و بستانکار برابر نباشد،
            احتمالاً سندی ناقص ثبت شده است؛ گزارش «دفتر کل» را بررسی کنید.
          </p>
        </Card>
      </div>
    </>
  );
}
