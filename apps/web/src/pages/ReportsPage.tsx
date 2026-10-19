import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileBarChart2, Play } from 'lucide-react';
import { api, isNotImplemented, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalali, lastNDaysISO, type DateRangeISO } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { ReportDefinition } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { InDevelopmentState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { SkeletonText } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';

const CATEGORY_LABELS: Record<string, string> = {
  operational: 'عملیاتی',
  financial: 'مالی',
  inventory: 'انبار',
  sales: 'فروش',
  accounting: 'حسابداری',
  audit: 'حسابرسی',
};

interface ReportColumn {
  readonly key: string;
  readonly titleFa: string;
}

interface ReportRunResponse {
  readonly rows?: readonly Record<string, string | number | boolean | null>[];
  readonly columns?: readonly ReportColumn[];
  readonly jobId?: string;
  readonly meta?: unknown;
}

/** Report catalog + synchronous/async report runner. */
export function ReportsPage() {
  useDocumentTitle('گزارش‌ها');
  const toast = useToast();
  const canRead = useHasPermission(PERM.reportRead);
  const canRun = useHasPermission(PERM.reportRun);
  const [search, setSearch] = useState('');
  const [selectedReport, setSelectedReport] = useState<ReportDefinition | null>(null);
  const [range, setRange] = useState<DateRangeISO>(() => lastNDaysISO(30));
  const [format, setFormat] = useState('json');

  const catalogQuery = useQuery({
    queryKey: queryKeys.reports.catalog(),
    queryFn: () => api.get<readonly ReportDefinition[]>('/reports', { perPage: 100 }),
    enabled: canRead,
    staleTime: 10 * 60_000,
  });

  const runMutation = useMutation({
    mutationFn: () => {
      if (selectedReport === null) {
        throw new Error('گزارشی انتخاب نشده است.');
      }
      return api.post<ReportRunResponse>(
        `/reports/${selectedReport.code}/run`,
        { params: { from: range.from, to: range.to }, format },
        { idempotencyKey: newRequestId() },
      );
    },
    onSuccess: (result) => {
      if (result.jobId !== undefined) {
        toast.info('گزارش در صف تولید قرار گرفت', 'نتیجه پس از پردازش در تاریخچه اجراها قابل دریافت است.');
        setSelectedReport(null);
        return;
      }
      toast.success('گزارش تولید شد');
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'اجرای این گزارش هنوز فعال نشده است.');
      } else {
        toast.error('اجرای گزارش ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  const grouped = useMemo(() => {
    const reports = catalogQuery.data ?? [];
    const filtered =
      search.trim() === ''
        ? reports
        : reports.filter(
            (report) =>
              report.titleFa.includes(search.trim()) || report.code.includes(search.trim().toLowerCase()),
          );
    const groups = new Map<string, ReportDefinition[]>();
    for (const report of filtered) {
      const category = report.category ?? 'other';
      const list = groups.get(category) ?? [];
      list.push(report);
      groups.set(category, list);
    }
    return [...groups.entries()];
  }, [catalogQuery.data, search]);

  const runResult = runMutation.data;

  if (!canRead) {
    return (
      <>
        <PageHeader title="گزارش‌ها" />
        <PermissionNotice permission={PERM.reportRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="گزارش‌ها"
        description="گزارش‌های عملیاتی و مالی؛ اجرا بر اساس بازه شمسی"
        actions={
          canRun ? (
            <Badge tone="success">اجازه اجرای گزارش دارید</Badge>
          ) : (
            <Badge tone="neutral">دسترسی اجرا ندارید</Badge>
          )
        }
      />

      <div className="mb-3 max-w-sm">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="جستجوی گزارش…"
          aria-label="جستجوی گزارش"
          className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 dark:border-slate-600 dark:bg-slate-900"
        />
      </div>

      {catalogQuery.isLoading && <SkeletonText lines={6} />}
      {catalogQuery.isError && (
        <ErrorState error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} />
      )}
      {catalogQuery.data !== undefined && catalogQuery.data.length === 0 && (
        <EmptyState
          icon={<FileBarChart2 className="size-9" />}
          title="گزارشی در فهرست وجود ندارد"
          description="گزارش‌های سامانه به‌صورت پیش‌فرض توسط سرویس ثبت می‌شوند."
        />
      )}

      <div className="space-y-4">
        {grouped.map(([category, reports]) => (
          <Card key={category} padding="none">
            <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {CATEGORY_LABELS[category] ?? category}
              </h2>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {reports.map((report) => (
                <li key={report.code} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <p className="text-sm text-slate-800 dark:text-slate-100">{report.titleFa}</p>
                    <p dir="ltr" className="text-[11px] text-slate-400">
                      {report.code}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Play className="size-3.5" />}
                    disabled={!canRun}
                    onClick={() => {
                      setSelectedReport(report);
                      runMutation.reset();
                    }}
                  >
                    اجرا
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      {runResult !== undefined && (
        <Card className="mt-4">
          <CardHeader
            title="نتیجه آخرین اجرا"
            description={`گزارش ${selectedReport?.titleFa ?? ''} · ${formatJalali(range.from)} تا ${formatJalali(range.to)}`}
            actions={<Badge tone="success">{formatNumber(runResult.rows?.length ?? 0)} سطر</Badge>}
          />
          {runResult.jobId !== undefined ? (
            <InDevelopmentState
              title="گزارش در پس‌زمینه در حال تولید است"
              description={`شناسه کار: ${runResult.jobId} — نتیجه پس از آماده‌شدن قابل دریافت خواهد بود.`}
            />
          ) : runResult.rows === undefined || runResult.rows.length === 0 ? (
            <EmptyState title="نتیجه‌ای برای این بازه وجود ندارد" />
          ) : runResult.columns === undefined ? (
            <InDevelopmentState
              title="قالب نمایش نتیجه تعریف نشده است"
              description="سرویس ستون‌های گزارش را برنگردانده است؛ نمایش جدولی پس از تکمیل قرارداد گزارش‌ها فعال می‌شود."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <tr>
                    {runResult.columns.map((column) => (
                      <th key={column.key} scope="col" className="px-3 py-2 text-start">
                        {column.titleFa}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runResult.rows.map((row, index) => (
                    <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      {runResult.columns?.map((column) => (
                        <td key={column.key} className="px-3 py-2 tabular">
                          {row[column.key] === null || row[column.key] === undefined
                            ? '—'
                            : String(row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Modal
        open={selectedReport !== null}
        onClose={() => setSelectedReport(null)}
        title={`اجرای گزارش: ${selectedReport?.titleFa ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setSelectedReport(null)}>
              انصراف
            </Button>
            <Button
              loading={runMutation.isPending}
              disabled={!canRun}
              onClick={() => runMutation.mutate()}
            >
              اجرای گزارش
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <DateRangePicker value={range} onChange={setRange} />
          <FormField label="قالب خروجی">
            <Select
              options={[
                { value: 'json', label: 'نمایش جدولی (JSON)' },
                { value: 'csv', label: 'CSV' },
                { value: 'xlsx', label: 'Excel' },
              ]}
              value={format}
              onChange={(event) => setFormat(event.target.value)}
            />
          </FormField>
          {runMutation.isError && <ErrorState error={runMutation.error} />}
        </div>
      </Modal>
    </>
  );
}
