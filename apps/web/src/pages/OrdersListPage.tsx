import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShoppingCart } from 'lucide-react';
import { api } from '../lib/api-client';
import { formatJalali } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { SalesOrderSummary } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { StatusBadge } from '../components/ui/Badge';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'submitted', label: 'ارسال‌شده' },
  { value: 'confirmed', label: 'تأییدشده' },
  { value: 'allocated', label: 'تخصیص‌یافته' },
  { value: 'picking', label: 'در حال برداشت' },
  { value: 'packed', label: 'بسته‌بندی‌شده' },
  { value: 'shipped', label: 'ارسال‌شده' },
  { value: 'on_hold', label: 'در انتظار' },
  { value: 'cancelled', label: 'لغو‌شده' },
];

const columns: readonly Column<SalesOrderSummary>[] = [
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
  {
    key: 'channel',
    header: 'کانال',
    render: (order) => order.channelCode ?? '—',
  },
  { key: 'status', header: 'وضعیت', render: (order) => <StatusBadge status={order.status} /> },
  {
    key: 'total',
    header: 'مبلغ کل',
    align: 'end',
    render: (order) => <span className="tabular">{order.total === undefined ? '—' : formatMoney(order.total)}</span>,
  },
  {
    key: 'createdAt',
    header: 'تاریخ ثبت',
    render: (order) => (order.createdAt === undefined ? '—' : formatJalali(order.createdAt)),
  },
];

/** Sales orders list across channels (cursor pagination). */
export function OrdersListPage() {
  useDocumentTitle('سفارش‌ها');
  const canRead = useHasPermission(PERM.orderRead);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<readonly (string | undefined)[]>([]);

  const query = useQuery({
    queryKey: queryKeys.orders.list({ status, search, cursor }),
    queryFn: () =>
      api.getPage<SalesOrderSummary>('/sales-orders', {
        limit: 25,
        ...(status === '' ? {} : { 'filter[status]': status }),
        ...(search.trim().length >= 2 ? { q: search.trim() } : {}),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    enabled: canRead,
    staleTime: 15_000,
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="سفارش‌ها" />
        <PermissionNotice permission={PERM.orderRead} />
      </>
    );
  }

  const pagination = query.data?.pagination;
  const items = query.data?.items ?? [];
  const hasMore = pagination?.nextCursor !== undefined && pagination?.nextCursor !== null;

  return (
    <>
      <PageHeader
        title="سفارش‌ها"
        description="سفارش‌های همه کانال‌ها در یک فهرست"
        breadcrumbs={[{ label: 'فروش' }, { label: 'سفارش‌ها' }]}
      />

      <DataTableToolbar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setCursor(undefined);
          setHistory([]);
        }}
        searchPlaceholder="جستجوی شماره سفارش یا مشتری…"
        filters={
          <Select
            aria-label="فیلتر وضعیت سفارش"
            options={STATUS_OPTIONS}
            value={status}
            className="w-44"
            onChange={(event) => {
              setStatus(event.target.value);
              setCursor(undefined);
              setHistory([]);
            }}
          />
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(order) => order.id}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        caption="فهرست سفارش‌ها"
        emptyTitle="سفارشی یافت نشد"
        emptyDescription="سفارش‌های کانال‌ها پس از همگام‌سازی در این فهرست نمایش داده می‌شوند."
        emptyAction={
          <EmptyState
            icon={<ShoppingCart className="size-8" />}
            title="هنوز سفارشی ثبت نشده است"
            description="برای ثبت سفارش دستی از دکمه «سفارش جدید» استفاده کنید."
          />
        }
      />

      <Pagination
        mode="cursor"
        hasMore={hasMore}
        canPrev={history.length > 0}
        disabled={query.isFetching}
        onNext={() => {
          const nextCursor = pagination?.nextCursor;
          if (nextCursor !== undefined && nextCursor !== null) {
            setHistory((current) => [...current, cursor]);
            setCursor(nextCursor);
          }
        }}
        onPrev={() => {
          const previous = history[history.length - 1];
          setHistory((current) => current.slice(0, -1));
          setCursor(previous);
        }}
      />
    </>
  );
}
