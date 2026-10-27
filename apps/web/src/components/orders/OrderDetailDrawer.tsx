import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageOpen, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api-client';
import { formatJalaliDateTime } from '../../lib/dates';
import { formatMoney, formatQuantity } from '../../lib/money';
import { queryKeys } from '../../lib/query-keys';
import type { Ref, SalesOrderSummary } from '../../types/api';
import { Badge, StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ErrorState } from '../ui/ErrorState';
import { Drawer } from '../ui/Modal';
import { SkeletonText } from '../ui/Skeleton';

type Amount = string | number | null | undefined;

/**
 * The dedicated order-detail endpoint returns the order plus its lines. The
 * line shape below also accepts the existing mapper's `net` field and the
 * nested variant name so an older API response still renders.
 */
interface OrderDetailLine {
  readonly lineNo?: number;
  readonly sku?: string | null;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly quantity?: string | number;
  readonly unitPrice?: string | number;
  readonly netAmount?: string | number;
  readonly net?: string | number;
  readonly total?: string | number;
}

interface OrderTotals {
  readonly subtotal?: Amount;
  readonly discount?: Amount;
  readonly tax?: Amount;
  readonly shipping?: Amount;
  readonly grandTotal?: Amount;
}

interface OrderDetail extends SalesOrderSummary {
  readonly customerName?: string;
  readonly channel?: (Ref & { nameFa?: string }) | null;
  readonly lines?: readonly OrderDetailLine[];
  readonly totals?: OrderTotals;
  readonly subtotal?: Amount;
  readonly discount?: Amount;
  readonly taxTotal?: Amount;
  readonly shippingTotal?: Amount;
}

export interface OrderDetailDrawerProps {
  /** Public id of the order to load; `null` keeps the drawer closed. */
  readonly orderId: string | null;
  readonly onClose: () => void;
}

function lineName(line: OrderDetailLine): string {
  return line.title ?? line.name ?? line.sku ?? 'قلم سفارش';
}

function lineTotal(line: OrderDetailLine): Amount {
  return line.netAmount ?? line.net ?? line.total;
}

function amountLabel(value: Amount): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  try {
    return formatMoney(value);
  } catch {
    return String(value);
  }
}

/** Sales-order detail drawer with lines, totals and channel. */
export function OrderDetailDrawer({ orderId, onClose }: OrderDetailDrawerProps) {
  const query = useQuery({
    queryKey: queryKeys.orders.detail(orderId ?? ''),
    queryFn: () => api.get<OrderDetail>(`/sales-orders/${orderId ?? ''}`),
    enabled: orderId !== null,
    retry: false,
    staleTime: 15_000,
  });

  const order = query.data;
  const lines = order?.lines ?? [];
  const orderTitle =
    order?.orderNumber !== undefined && order.orderNumber !== null && order.orderNumber !== ''
      ? order.orderNumber
      : orderId === null
        ? 'جزئیات سفارش'
        : `سفارش ${orderId.slice(0, 8)}`;
  const channel =
    order?.channelCode ?? order?.channel?.nameFa ?? order?.channel?.name ?? order?.channel?.code ?? '—';
  const customer = order?.customer?.name ?? order?.customerName ?? '—';

  const totalRows: readonly { readonly label: string; readonly value: Amount }[] =
    order === undefined
      ? []
      : (
          [
            { label: 'جمع اقلام', value: order.totals?.subtotal ?? order.subtotal },
            { label: 'تخفیف', value: order.totals?.discount ?? order.discount },
            { label: 'مالیات', value: order.totals?.tax ?? order.taxTotal },
            { label: 'هزینه ارسال', value: order.totals?.shipping ?? order.shippingTotal },
            { label: 'مبلغ کل', value: order.totals?.grandTotal ?? order.total },
          ] as const
        ).filter((row) => row.value !== null && row.value !== undefined && row.value !== '');

  return (
    <Drawer
      open={orderId !== null}
      onClose={onClose}
      title={orderTitle}
      description={order === undefined ? undefined : `مشتری: ${customer}`}
      side="end"
      footer={
        orderId === null ? undefined : (
          <Link
            to="/orders/$id"
            params={{ id: orderId }}
            className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
          >
            مشاهده صفحه کامل سفارش
          </Link>
        )
      }
    >
      {orderId !== null && query.isLoading ? <SkeletonText lines={8} /> : null}

      {query.isError && order === undefined ? (
        <ErrorState
          title="دریافت جزئیات سفارش ناموفق بود"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {order !== undefined ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={order.status} />
            <Badge tone="info">کانال: {channel}</Badge>
            {order.createdAt !== undefined && (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                {formatJalaliDateTime(order.createdAt)}
              </span>
            )}
          </div>

          <section aria-labelledby="order-lines-title">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="order-lines-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                اقلام سفارش
              </h3>
              <Badge tone="neutral">{lines.length.toLocaleString('fa-IR')} قلم</Badge>
            </div>

            {lines.length === 0 ? (
              <EmptyState
                icon={<PackageOpen className="size-8" />}
                title="اقلام این سفارش ثبت نشده"
                description="خطوط سفارش از سرور دریافت نشدند یا هنوز ثبت نشده‌اند. اگر سفارش تازه ایجاد شده است، دوباره تلاش کنید."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<RefreshCw aria-hidden className="size-4" />}
                    loading={query.isFetching}
                    onClick={() => void query.refetch()}
                  >
                    تلاش مجدد
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-2">
                {lines.map((line, index) => (
                  <li
                    key={`${line.lineNo ?? index}-${line.sku ?? ''}-${index}`}
                    className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {lineName(line)}
                      </span>
                      <span className="shrink-0 text-xs font-semibold tabular text-slate-700 dark:text-slate-200">
                        {amountLabel(lineTotal(line))}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {line.sku !== undefined && line.sku !== null && line.sku !== '' && (
                        <span dir="ltr" className="font-mono">
                          {line.sku}
                        </span>
                      )}
                      {line.quantity !== undefined && <span>تعداد: {formatQuantity(line.quantity)}</span>}
                      {line.unitPrice !== undefined && <span>قیمت واحد: {amountLabel(line.unitPrice)}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {totalRows.length > 0 && (
            <section aria-labelledby="order-totals-title">
              <h3
                id="order-totals-title"
                className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
              >
                جمع‌بندی سفارش
              </h3>
              <dl className="space-y-1.5 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
                {totalRows.map((row) => {
                  const emphasized = row.label === 'مبلغ کل';
                  return (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                      <dt
                        className={
                          emphasized
                            ? 'font-semibold text-slate-900 dark:text-slate-100'
                            : 'text-slate-600 dark:text-slate-300'
                        }
                      >
                        {row.label}
                      </dt>
                      <dd
                        className={
                          emphasized
                            ? 'font-semibold tabular text-slate-900 dark:text-slate-100'
                            : 'tabular text-slate-700 dark:text-slate-200'
                        }
                      >
                        {amountLabel(row.value)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
