import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  Link2,
  Package,
  RefreshCw,
  ShoppingBag,
  TrendingUp,
  Truck,
  Warehouse,
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
import { formatJalali, formatJalaliDateTime } from '../lib/dates';
import { formatMoney, formatNumber } from '../lib/money';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { DashboardChannelStatus, DashboardSummary } from '../types/api';
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

const EMPTY_DATA = 'هنوز داده‌ای ثبت نشده';

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

const SYNC_STATUS: Record<string, { readonly label: string; readonly tone: 'success' | 'danger' | 'info' | 'neutral' }> = {
  succeeded: { label: 'موفق', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'danger' },
  running: { label: 'در حال اجرا', tone: 'info' },
  queued: { label: 'در صف', tone: 'neutral' },
  ok: { label: 'سالم', tone: 'success' },
};

function SyncStatusBadge({ status }: { readonly status: string | null }) {
  if (status === null) {
    return <Badge tone="neutral">بدون همگام‌سازی</Badge>;
  }
  const mapped = SYNC_STATUS[status];
  return <Badge tone={mapped?.tone ?? 'neutral'}>{mapped?.label ?? status}</Badge>;
}

const channelColumns: readonly Column<DashboardChannelStatus>[] = [
  {
    key: 'name',
    header: 'کانال',
    render: (channel) => (
      <div className="flex flex-col">
        <span className="font-medium text-slate-800 dark:text-slate-100">{channel.name}</span>
        <span className="text-[11px] text-slate-400" dir="ltr">
          {channel.channelCode}
        </span>
      </div>
    ),
  },
  {
    key: 'lastSyncAt',
    header: 'آخرین همگام‌سازی',
    render: (channel) =>
      channel.lastSyncAt === null ? (
        <span className="text-xs text-slate-400">{EMPTY_DATA}</span>
      ) : (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {formatJalaliDateTime(channel.lastSyncAt)}
        </span>
      ),
  },
  {
    key: 'lastSyncStatus',
    header: 'وضعیت',
    render: (channel) => <SyncStatusBadge status={channel.lastSyncStatus} />,
  },
  {
    key: 'stockPushEnabled',
    header: 'ارسال موجودی',
    render: (channel) => (
      <Badge tone={channel.stockPushEnabled ? 'success' : 'neutral'}>
        {channel.stockPushEnabled ? 'فعال' : 'غیرفعال'}
      </Badge>
    ),
  },
];

/** Home dashboard: KPIs, sales trend, channel sync, Digikala status, recent orders. */
export function DashboardPage() {
  useDocumentTitle('داشبورد');
  const canReadDashboard = useHasPermission(PERM.dashboardRead);
  const canReadOrders = useHasPermission(PERM.orderRead);

  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => api.get<DashboardSummary>('/dashboard/summary'),
    enabled: canReadDashboard,
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

  const products = summary?.products;
  const inventory = summary?.inventory;
  const orders = summary?.orders;
  const sales = summary?.sales;
  const channels = summary?.channels ?? [];
  const digikala = summary?.digikala;

  const noProducts = products !== undefined && products.total === 0;
  const noInventory = inventory !== undefined && inventory.skuCount === 0;
  const noSalesToday =
    sales !== undefined && (summary?.salesTodayCount ?? 0) === 0 && sales.todayAmount === '0';
  const noSalesMonth = sales !== undefined && sales.monthAmount === '0';

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
          value={
            summaryQuery.isLoading
              ? ''
              : sales === undefined || noSalesToday
                ? EMPTY_DATA
                : formatMoney(sales.todayAmount)
          }
          hint={
            summary?.salesTodayCount === undefined
              ? undefined
              : `${formatNumber(summary.salesTodayCount)} فاکتور`
          }
          icon={<CircleDollarSign className="size-5" />}
          tone="success"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="فروش این ماه"
          value={
            summaryQuery.isLoading
              ? ''
              : sales === undefined || noSalesMonth
                ? EMPTY_DATA
                : formatMoney(sales.monthAmount)
          }
          hint="از ابتدای ماه شمسی"
          icon={<TrendingUp className="size-5" />}
          tone="brand"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="سفارش‌های باز"
          value={orders === undefined ? '—' : formatNumber(orders.open)}
          hint={orders === undefined ? undefined : `${formatNumber(orders.today)} سفارش امروز`}
          icon={<ClipboardList className="size-5" />}
          tone="brand"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="اقلام کم‌موجود"
          value={summary?.lowStockCount === undefined ? '—' : formatNumber(summary.lowStockCount)}
          hint="موجودی قابل فروش صفر یا کمتر"
          icon={<ShoppingBag className="size-5" />}
          tone="warning"
          loading={summaryQuery.isLoading}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="کالاهای فعال"
          value={
            summaryQuery.isLoading
              ? ''
              : products === undefined || noProducts
                ? EMPTY_DATA
                : formatNumber(products.active)
          }
          hint={products === undefined ? undefined : `از ${formatNumber(products.total)} کالا`}
          icon={<Package className="size-5" />}
          tone="brand"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="کالاهای بدون موجودی"
          value={
            summaryQuery.isLoading
              ? ''
              : products === undefined || noProducts
                ? EMPTY_DATA
                : formatNumber(products.outOfStock)
          }
          icon={<AlertTriangle className="size-5" />}
          tone={products !== undefined && products.outOfStock > 0 ? 'danger' : 'default'}
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="موجودی انبار"
          value={
            summaryQuery.isLoading
              ? ''
              : inventory === undefined || noInventory
                ? EMPTY_DATA
                : formatNumber(inventory.onHandTotal, 2)
          }
          hint={inventory === undefined ? undefined : `${formatNumber(inventory.skuCount)} قلم کالا`}
          icon={<Warehouse className="size-5" />}
          loading={summaryQuery.isLoading}
        />
        <StatCard
          title="تعداد SKU موجود"
          value={
            summaryQuery.isLoading
              ? ''
              : inventory === undefined || noInventory
                ? EMPTY_DATA
                : formatNumber(inventory.skuCount)
          }
          icon={<Boxes className="size-5" />}
          loading={summaryQuery.isLoading}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="روند فروش"
            description="مبالغ به ریال؛ ۱۴ روز اخیر از سرور"
            actions={summaryQuery.isFetching ? <RefreshCw aria-hidden className="size-4 animate-spin text-slate-400" /> : undefined}
          />
          {summaryQuery.isLoading ? (
            <SkeletonText lines={5} />
          ) : chartData.length === 0 ? (
            <EmptyState
              title={EMPTY_DATA}
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
            title="وضعیت دیجی‌کالا"
            description="اتصال و آخرین همگام‌سازی فروشگاه"
            actions={
              digikala === undefined ? undefined : (
                <Badge tone={digikala.connected ? 'success' : 'neutral'}>
                  {digikala.connected ? 'متصل' : 'متصل نشده'}
                </Badge>
              )
            }
          />
          {summaryQuery.isLoading ? (
            <SkeletonText lines={4} />
          ) : digikala === undefined || !digikala.connected ? (
            <EmptyState
              icon={<Link2 className="size-8" />}
              title="دیجی‌کالا متصل نشده است"
              description="برای مشاهده وضعیت همگام‌سازی، حساب فروشندگی دیجی‌کالا را در صفحه کانال‌ها ثبت کنید."
            />
          ) : (
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500 dark:text-slate-400">توکن دسترسی</dt>
                <dd>
                  <Badge tone={digikala.accessTokenPresent ? 'success' : 'warning'}>
                    {digikala.accessTokenPresent ? 'ثبت شده' : 'ثبت نشده'}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500 dark:text-slate-400">آخرین دریافت سفارش</dt>
                <dd className="tabular text-slate-700 dark:text-slate-200">
                  {digikala.lastOrderPullAt === null
                    ? EMPTY_DATA
                    : formatJalaliDateTime(digikala.lastOrderPullAt)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500 dark:text-slate-400">آخرین ارسال موجودی</dt>
                <dd className="tabular text-slate-700 dark:text-slate-200">
                  {digikala.lastPushAt === null ? EMPTY_DATA : formatJalaliDateTime(digikala.lastPushAt)}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                <dt className="text-slate-500 dark:text-slate-400">آخرین خطا</dt>
                <dd className="max-w-[65%] break-words text-end text-slate-700 dark:text-slate-200">
                  {digikala.lastError === null ? (
                    <Badge tone="success">خطایی ثبت نشده</Badge>
                  ) : (
                    <span className="text-red-600 dark:text-red-400" dir="auto">
                      {digikala.lastError}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="وضعیت همگام‌سازی کانال‌ها"
          description="آخرین همگام‌سازی هر حساب کانال"
          actions={
            <Link to="/channels" className="text-xs text-brand-700 hover:underline dark:text-brand-300">
              مدیریت کانال‌ها
            </Link>
          }
        />
        <DataTable
          columns={channelColumns}
          rows={channels}
          rowKey={(channel) => channel.accountId}
          loading={summaryQuery.isLoading}
          emptyTitle={EMPTY_DATA}
          emptyDescription="با اتصال اولین کانال، وضعیت همگام‌سازی آن در این جدول نمایش داده می‌شود."
        />
      </Card>

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
              emptyTitle={EMPTY_DATA}
              emptyDescription="سفارش‌های جدید پس از ثبت در این فهرست نمایش داده می‌شوند."
            />
          )}
        </Card>

        <Card>
          <CardHeader title="اقلام کم‌موجود" description="نیازمند تأمین یا بازبینی موجودی" />
          {summary?.lowStock === undefined || summary.lowStock.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle className="size-8" />}
              title={EMPTY_DATA}
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
