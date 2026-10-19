import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  RefreshCw,
  ShoppingBag,
  Truck,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api-client';
import { formatJalali } from '../lib/dates';
import { formatMoney, formatNumber } from '../lib/money';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { ChannelHealthRow, DashboardSummary } from '../types/api';
import { Can, PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { DataTable, type Column } from '../components/ui/Table';
import { SkeletonText } from '../components/ui/Skeleton';
import type { SalesOrderSummary } from '../types/api';

const orderColumns: readonly Column<SalesOrderSummary>[] = [
  {
    key: 'orderNumber',
    header: 'شماره سفارش',
    render: (order) => (
      <Link
        to="/orders/$id"
        params={{ id: order.id }}
        className="font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        {order.orderNumber ?? order.id.slice(0, 8)}
      </Link>
    ),
  },
  { key: 'customer', header: 'مشتری', render: (order) => order.customer?.name ?? '—' },
  { key: 'status', header: 'وضعیت', render: (order) => <StatusBadge status={order.status} /> },
  {
    key: 'total',
    header: 'مبلغ',
    align: 'end',
    render: (order) => (
      <span className="tabular">{order.total === undefined ? '—' : formatMoney(order.total)}</span>
    ),
  },
];

/** Home dashboard: KPIs, sales trend, low stock, recent orders, sync health. */
export function DashboardPage() {
  useDocumentTitle('داشبورد');
  const canReadDashboard = useHasPermission(PERM.dashboardRead);
  const canReadOrders = useHasPermission(PERM.orderRead);
  const canReadChannels = useHasPermission(PERM.channelRead);

  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => api.get<DashboardSummary>('/dashboard/summary'),
    enabled: canReadDashboard,
    staleTime: 60_000,
  });

  const healthQuery = useQuery({
    queryKey: queryKeys.channels.health,
    queryFn: () => api.get<readonly ChannelHealthRow[]>('/channels/health'),
    enabled: canReadChannels,
    staleTime: 60_000,
  });

  if (!canReadDashboard) {
    return (
      <>
        <PageHeader title="داشبورد" />
        <PermissionNotice permission={PERM.dashboardRead} />
      </>
    );
  }

  const summary = summaryQuery.data;
  const series = summary?.salesSeries ?? [];
  const chartData = series.map((point) => ({
    date: point.date,
    label: formatJalali(point.date),
    amount: Number(point.amount),
  }));

  return (
    <>
      <PageHeader
        title="داشبورد"
        description="نمای کلی فروش، موجودی و سلامت کانال‌ها"
        actions={
          <Can permission={PERM.reportRead}>
            <Link
              to="/reports"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              گزارش‌ها
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </Can>
        }
      />

      {summaryQuery.isError && (
        <div className="mb-4">
          <ErrorState
            message="دریافت خلاصه داشبورد ناموفق بود."
            error={summaryQuery.error}
            onRetry={() => void summaryQuery.refetch()}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="فروش امروز"
          value={summary?.salesToday === undefined ? '—' : formatMoney(summary.salesToday)}
          hint={summary?.salesTodayCount === undefined ? undefined : `${formatNumber(summary.salesTodayCount)} سفارش`}
          icon={<CircleDollarSign className="size-5" />}
          tone="success"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="سفارش‌های باز"
          value={summary?.openOrders === undefined ? '—' : formatNumber(summary.openOrders)}
          icon={<ClipboardList className="size-5" />}
          tone="brand"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="اقلام کم‌موجود"
          value={summary?.lowStockCount === undefined ? '—' : formatNumber(summary.lowStockCount)}
          icon={<Boxes className="size-5" />}
          tone="warning"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="مانده حساب‌های دریافتنی"
          value={summary?.receivable === undefined ? '—' : formatMoney(summary.receivable)}
          icon={<ShoppingBag className="size-5" />}
          loading={summaryQuery.isLoading}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="روند فروش"
            description="مبالغ به ریال؛ داده‌ها از سرور دریافت می‌شود."
            actions={summaryQuery.isFetching ? <RefreshCw aria-hidden className="size-4 animate-spin text-slate-400" /> : undefined}
          />
          {summaryQuery.isLoading ? (
            <SkeletonText lines={5} />
          ) : chartData.length === 0 ? (
            <EmptyState
              title="داده نمودار در دسترس نیست"
              description="پس از ثبت فروش، روند فروش در این نمودار نمایش داده می‌شود."
            />
          ) : (
            <div className="h-64 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0f766e" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#0f766e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={70} />
                  <ChartTooltip
                    formatter={(value) => [formatMoney(String(value), { unit: '' }), 'فروش']}
                  />
                  <Area type="monotone" dataKey="amount" stroke="#0f766e" fill="url(#salesFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="سلامت یکپارچه‌سازی‌ها"
            description="وضعیت آخرین همگام‌سازی کانال‌ها"
            actions={
              <Link to="/channels" className="text-xs text-brand-700 hover:underline dark:text-brand-300">
                جزئیات
              </Link>
            }
          />
          {!canReadChannels ? (
            <p className="text-xs text-slate-500">برای مشاهده، دسترسی کانال لازم است.</p>
          ) : healthQuery.isLoading ? (
            <SkeletonText lines={4} />
          ) : healthQuery.isError ? (
            <ErrorState message="دریافت وضعیت کانال‌ها ناموفق بود." onRetry={() => void healthQuery.refetch()} />
          ) : (healthQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">کانالی تنظیم نشده است.</p>
          ) : (
            <ul className="space-y-2">
              {(healthQuery.data ?? []).slice(0, 4).map((row, index) => (
                <li
                  key={row.id ?? `${row.account?.id ?? index}`}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate text-slate-700 dark:text-slate-200">
                    {row.channel?.nameFa ?? row.channel?.name ?? 'کانال'}
                  </span>
                  <Badge
                    tone={
                      row.failureStreak !== undefined && row.failureStreak > 0
                        ? 'warning'
                        : 'success'
                    }
                  >
                    {row.failureStreak !== undefined && row.failureStreak > 0
                      ? `${formatNumber(row.failureStreak)} خطای پیاپی`
                      : 'سالم'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="آخرین سفارش‌ها"
            actions={
              <Can permission={PERM.orderRead}>
                <Link to="/orders" className="text-xs text-brand-700 hover:underline dark:text-brand-300">
                  همه سفارش‌ها
                </Link>
              </Can>
            }
          />
          {!canReadOrders ? (
            <p className="text-xs text-slate-500">برای مشاهده، دسترسی سفارش لازم است.</p>
          ) : summaryQuery.isLoading ? (
            <SkeletonText lines={3} />
          ) : (
            <DataTable
              columns={orderColumns}
              rows={summary?.recentOrders ?? []}
              rowKey={(order) => order.id}
              emptyTitle="سفارشی ثبت نشده است"
              emptyDescription="سفارش‌های جدید پس از ثبت در این فهرست نمایش داده می‌شوند."
            />
          )}
        </Card>

        <Card>
          <CardHeader title="اقلام کم‌موجود" description="نیازمند تأمین یا بازبینی موجودی" />
          {summary?.lowStock === undefined || summary.lowStock.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle className="size-8" />}
              title="هشدار موجودی وجود ندارد"
              description="در صورت افت موجودی، اقلام در این بخش فهرست می‌شوند."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {summary.lowStock.slice(0, 6).map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                  <span className="truncate text-slate-700 dark:text-slate-200">
                    {row.product?.name ?? row.variant?.name ?? row.variant?.code ?? 'کالا'}
                  </span>
                  <span className="tabular text-slate-500">
                    موجودی: {formatNumber(row.available ?? row.onHand, 2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-400 dark:border-slate-800">
            <Truck aria-hidden className="size-4" />
            موجودی قابل فروش = موجودی انبار − رزرو − ذخیره ایمنی
          </div>
        </Card>
      </div>
    </>
  );
}
