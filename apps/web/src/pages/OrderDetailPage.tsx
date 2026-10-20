import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CheckCircle2,
  Hand,
  PlayCircle,
  RotateCcw,
  Send,
  Split,
} from 'lucide-react';
import { api, isNotImplemented, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatMoney, formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { usePathParam } from '../lib/router';
import { useHasPermission } from '../lib/use-auth';
import type { SalesOrderDetail, SalesOrderSummary } from '../types/api';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState, InDevelopmentState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';

type OrderAction = 'submit' | 'confirm' | 'allocate' | 'deallocate' | 'hold' | 'release' | 'cancel';

interface ActionDefinition {
  readonly action: OrderAction;
  readonly label: string;
  readonly icon: typeof Send;
  readonly variant: 'primary' | 'secondary' | 'outline' | 'danger';
  readonly requiresReason?: boolean;
  readonly description?: string;
}

const ACTION_DEFINITIONS: Record<OrderAction, ActionDefinition> = {
  submit: { action: 'submit', label: 'ارسال سفارش', icon: Send, variant: 'primary' },
  confirm: {
    action: 'confirm',
    label: 'تأیید و رزرو موجودی',
    icon: CheckCircle2,
    variant: 'primary',
    description: 'با تأیید سفارش، موجودی به‌صورت اتمیک رزرو می‌شود.',
  },
  allocate: { action: 'allocate', label: 'تخصیص انبار', icon: Split, variant: 'primary' },
  deallocate: {
    action: 'deallocate',
    label: 'آزادسازی تخصیص',
    icon: RotateCcw,
    variant: 'outline',
    requiresReason: true,
  },
  hold: {
    action: 'hold',
    label: 'قرار دادن در انتظار',
    icon: Hand,
    variant: 'outline',
    requiresReason: true,
  },
  release: { action: 'release', label: 'خروج از انتظار', icon: PlayCircle, variant: 'outline' },
  cancel: {
    action: 'cancel',
    label: 'لغو سفارش',
    icon: Ban,
    variant: 'danger',
    requiresReason: true,
  },
};

function actionsForStatus(status: string): readonly OrderAction[] {
  switch (status) {
    case 'draft':
      return ['submit', 'cancel'];
    case 'submitted':
      return ['confirm', 'cancel'];
    case 'confirmed':
      return ['allocate', 'hold', 'cancel'];
    case 'allocated':
      return ['deallocate', 'hold', 'cancel'];
    case 'on_hold':
      return ['release', 'cancel'];
    case 'picking':
    case 'packed':
      return ['cancel'];
    default:
      return [];
  }
}

/** Sales order detail with status-machine actions, allocation and cancel. */
export function OrderDetailPage() {
  const id = usePathParam('id');
  useDocumentTitle('جزئیات سفارش');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canUpdate = useHasPermission(PERM.orderUpdate);
  const [pendingAction, setPendingAction] = useState<OrderAction | null>(null);

  const orderQuery = useQuery({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () =>
      api.get<SalesOrderDetail>(`/sales-orders/${id}`, {
        include: 'lines,allocations,shipments,history,customer',
      }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, reason }: { action: OrderAction; reason?: string }) => {
      const order = orderQuery.data;
      const body: Record<string, unknown> = {};
      if (reason !== undefined) {
        body['reason'] = reason;
      }
      return api.post<SalesOrderSummary>(`/sales-orders/${id}/${action}`, body, {
        ...(order?.version === undefined ? {} : { ifMatch: order.version }),
      });
    },
    onSuccess: () => {
      toast.success('عملیات با موفقیت انجام شد');
      setPendingAction(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(id) });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'این عملیات هنوز در سرویس فعال نشده است.');
      } else {
        toast.error('عملیات سفارش ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  if (orderQuery.isLoading) {
    return <Card>در حال دریافت سفارش…</Card>;
  }
  if (orderQuery.isError || orderQuery.data === undefined) {
    return (
      <>
        <PageHeader title="جزئیات سفارش" breadcrumbs={[{ label: 'سفارش‌ها', to: '/orders' }]} />
        <ErrorState
          title="دریافت سفارش ناموفق بود"
          error={orderQuery.error}
          onRetry={() => void orderQuery.refetch()}
        />
      </>
    );
  }

  const order = orderQuery.data;
  const lines = order.lines ?? [];
  const actions = actionsForStatus(order.status);
  const pendingDefinition = pendingAction === null ? null : ACTION_DEFINITIONS[pendingAction];
  const history = order.history ?? [];

  return (
    <>
      <PageHeader
        title={order.orderNumber ?? `سفارش ${order.id.slice(0, 8)}`}
        description={order.customer?.name === undefined ? undefined : `مشتری: ${order.customer.name}`}
        breadcrumbs={[{ label: 'فروش' }, { label: 'سفارش‌ها', to: '/orders' }, { label: order.orderNumber ?? 'جزئیات' }]}
        actions={
          canUpdate ? (
            <>
              {actions.map((actionName) => {
                const definition = ACTION_DEFINITIONS[actionName];
                const Icon = definition.icon;
                return (
                  <Button
                    key={actionName}
                    variant={definition.variant}
                    icon={<Icon className="size-4" />}
                    onClick={() => setPendingAction(actionName)}
                    disabled={actionMutation.isPending}
                  >
                    {definition.label}
                  </Button>
                );
              })}
            </>
          ) : (
            <Badge tone="neutral">دسترسی فقط خواندن</Badge>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={order.status} />
        {order.channelCode !== undefined && <Badge tone="info">کانال: {order.channelCode}</Badge>}
        {order.warehouse?.name !== undefined && <Badge tone="brand">انبار: {order.warehouse.name}</Badge>}
        {order.createdAt !== undefined && (
          <span className="text-xs text-slate-500">{formatJalaliDateTime(order.createdAt)}</span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="اقلام سفارش" description={`${lines.length.toLocaleString('fa-IR')} قلم`} />
          {lines.length === 0 ? (
            <EmptyState title="قلمی برای این سفارش ثبت نشده است" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start">کالا</th>
                    <th scope="col" className="px-3 py-2 text-end">مقدار</th>
                    <th scope="col" className="px-3 py-2 text-end">قیمت واحد</th>
                    <th scope="col" className="px-3 py-2 text-end">تخصیص</th>
                    <th scope="col" className="px-3 py-2 text-end">جمع</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2">
                        {line.variant?.name ?? line.sku ?? '—'}
                        {line.variant?.code !== undefined && (
                          <span dir="ltr" className="ms-2 text-xs text-slate-400">
                            {line.variant.code}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end tabular">{formatQuantity(line.quantity)}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(line.unitPrice)}</td>
                      <td className="px-3 py-2 text-end tabular">
                        {line.allocatedQuantity === undefined ? '—' : formatQuantity(line.allocatedQuantity)}
                      </td>
                      <td className="px-3 py-2 text-end tabular">
                        {line.total === undefined ? '—' : formatMoney(line.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-medium dark:bg-slate-800">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-end">جمع کل</td>
                    <td className="px-3 py-2 text-end tabular">
                      {order.total === undefined ? '—' : formatMoney(order.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="تاریخچه وضعیت" />
            {history.length === 0 ? (
              <p className="text-xs text-slate-500">تاریخچه‌ای ثبت نشده است.</p>
            ) : (
              <ol className="space-y-2">
                {history.map((entry, index) => (
                  <li key={`${entry.status}-${index}`} className="flex items-start gap-2 text-xs">
                    <span className="mt-1 size-2 shrink-0 rounded-full bg-brand-600" aria-hidden />
                    <div>
                      <p className="font-medium text-slate-700 dark:text-slate-200">
                        <StatusBadge status={entry.status} />
                      </p>
                      <p className="text-slate-500">
                        {formatJalaliDateTime(entry.at)}
                        {entry.actor?.name === undefined ? '' : ` · ${entry.actor.name}`}
                      </p>
                      {entry.reason !== undefined && <p className="text-slate-400">{entry.reason}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <CardHeader title="یادداشت‌ها" />
            <p className="whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
              {order.notes ?? 'یادداشتی ثبت نشده است.'}
            </p>
          </Card>
        </div>
      </div>

      {pendingDefinition !== null && (
        <ConfirmDialog
          open={pendingAction !== null}
          title={pendingDefinition.label}
          {...(pendingDefinition.description === undefined
            ? {}
            : { description: pendingDefinition.description })}
          confirmLabel={pendingDefinition.label}
          tone={pendingDefinition.variant === 'danger' ? 'danger' : 'primary'}
          requireReason={pendingDefinition.requiresReason === true}
          reasonLabel="دلیل این عملیات"
          loading={actionMutation.isPending}
          onConfirm={(reason) => {
            if (pendingAction !== null) {
              actionMutation.mutate({ action: pendingAction, ...(reason === undefined ? {} : { reason }) });
            }
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {!canUpdate && (
        <div className="mt-4">
          <InDevelopmentState
            title="دسترسی ویرایش سفارش"
            description="برای انجام عملیات روی سفارش (تأیید، تخصیص، لغو) به دسترسی sales.order.update نیاز دارید."
          />
        </div>
      )}
    </>
  );
}
