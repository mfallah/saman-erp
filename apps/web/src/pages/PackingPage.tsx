import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  PackageCheck,
  Play,
  RefreshCw,
  Scale,
  Truck,
} from 'lucide-react';
import { api, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber, formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { PackBoardDiagnostics, PackTask, PackTaskBoard } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Modal,
  NumberInput,
  PageHeader,
  StatCard,
  type BadgeTone,
  type Column,
} from '../components/ui';
import { useToast } from '../components/ui/Toast';

/** Pack task statuses, in Persian. */
const PACK_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'در انتظار بسته‌بندی', tone: 'warning' },
  packing: { label: 'در حال بسته‌بندی', tone: 'info' },
  packed: { label: 'بسته‌بندی‌شده', tone: 'success' },
  shipped: { label: 'ارسال‌شده', tone: 'neutral' },
  cancelled: { label: 'لغو‌شده', tone: 'danger' },
};

const FULFILLMENT_LABELS: Record<string, string> = {
  unfulfilled: 'در انتظار',
  picked: 'برداشت‌شده',
  ready_to_ship: 'آمادهٔ ارسال',
  shipped: 'ارسال‌شده',
  delivered: 'تحویل‌شده',
};

function packStatusBadge(status: string) {
  const meta = PACK_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function ageLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'همین حالا';
  if (minutes < 60) return `${formatNumber(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${formatNumber(hours)} ساعت`;
  return `${formatNumber(Math.floor(hours / 24))} روز`;
}

/**
 * Explains exactly why the packing queue is empty: the `pack_tasks` migration
 * missing, no order fully picked yet, picked orders without a pack task, or
 * simply everything packed.
 */
function PackQueueEmptyState({ diagnostics }: { readonly diagnostics: PackBoardDiagnostics }) {
  if (diagnostics.tasksTotal === 0) {
    if (diagnostics.pickedTasks === 0 && diagnostics.pickedOrders === 0) {
      return (
        <EmptyState
          icon={<PackageCheck className="size-9" />}
          title="هنوز هیچ سفارشی کامل برداشت نشده است"
          description="تسک بسته‌بندی زمانی ساخته می‌شود که همهٔ قلم‌های یک سفارش در ایستگاه برداشت تکمیل شوند."
        />
      );
    }
    if (diagnostics.pickedOrdersWithoutPackTask > 0) {
      return (
        <EmptyState
          icon={<AlertTriangle className="size-9 text-amber-500" />}
          title={`${formatNumber(diagnostics.pickedOrdersWithoutPackTask)} سفارش برداشت‌شده تسک بسته‌بندی ندارد`}
          description="این سفارش‌ها وضعیت «برداشت‌شده» دارند اما ردیفی در pack_tasks ندارند؛ مهاجرت جدول بسته‌بندی یا رویداد تکمیل برداشت را بررسی کنید."
        />
      );
    }
    return (
      <EmptyState
        icon={<PackageCheck className="size-9" />}
        title="صف بسته‌بندی خالی است"
        description="پس از تکمیل برداشت سفارش، تسک بسته‌بندی به‌صورت خودکار در این صف ظاهر می‌شود."
      />
    );
  }
  return (
    <EmptyState
      icon={<CheckCircle2 className="size-9 text-emerald-500" />}
      title="همهٔ بسته‌ها آمادهٔ ارسال‌اند"
      description={`${formatNumber(diagnostics.packed)} بسته بسته‌بندی و سفارش‌ها برای ارسال علامت‌گذاری شده‌اند.`}
    />
  );
}

/**
 * Packing station: summary counters, open pack tasks (created by the picking
 * station) and package confirmation. Completing a task marks the order
 * `ready_to_ship`; the API then performs a best-effort channel notification.
 */
export function PackingPage() {
  useDocumentTitle('ایستگاه بسته‌بندی');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.packRead);
  const canExecute = useHasPermission(PERM.packExecute);

  const [target, setTarget] = useState<PackTask | null>(null);
  const [packageNo, setPackageNo] = useState('');
  const [weight, setWeight] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const boardQuery = useQuery({
    queryKey: queryKeys.fulfillment.packBoard,
    queryFn: () => api.get<PackTaskBoard>('/warehouse/pack-tasks/board'),
    enabled: canRead,
    refetchInterval: 15_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['pack-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['pick-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  };

  const startMutation = useMutation({
    mutationFn: (taskId: string) => api.post(`/warehouse/pack-tasks/${taskId}/start`, {}),
    onSuccess: () => {
      toast.success('بسته‌بندی آغاز شد', 'این وظیفه به نام شما ثبت شد.');
      invalidate();
    },
    onError: (error) => toast.error('شروع بسته‌بندی ناموفق بود', toFaErrorMessage(error)),
  });

  const completeMutation = useMutation({
    mutationFn: (input: { taskId: string; packageNo?: string; weight?: number }) =>
      api.post<{ packTask: PackTask; orderId: string; orderFulfillmentStatus: string }>(
        `/warehouse/pack-tasks/${input.taskId}/complete`,
        {
          ...(input.packageNo === undefined ? {} : { packageNo: input.packageNo }),
          ...(input.weight === undefined ? {} : { weight: input.weight }),
        },
      ),
    onSuccess: (result) => {
      setTarget(null);
      toast.success(
        'بسته مهر و موم شد',
        `${result.packTask.packageNo ?? ''} · سفارش «${FULFILLMENT_LABELS[result.orderFulfillmentStatus] ?? 'آمادهٔ ارسال'}» شد.`.trim(),
      );
      invalidate();
    },
    onError: (error) => setFormError(toFaErrorMessage(error)),
  });

  const openComplete = (task: PackTask): void => {
    setTarget(task);
    setPackageNo(task.packageNo ?? '');
    setWeight('');
    setFormError(null);
  };

  const submitComplete = (): void => {
    if (target === null) return;
    const trimmedWeight = weight.trim();
    if (trimmedWeight !== '' && !Number.isFinite(Number(trimmedWeight))) {
      setFormError('وزن بسته باید یک عدد معتبر باشد.');
      return;
    }
    setFormError(null);
    completeMutation.mutate({
      taskId: target.id,
      ...(packageNo.trim() === '' ? {} : { packageNo: packageNo.trim() }),
      ...(trimmedWeight === '' ? {} : { weight: Number(trimmedWeight) }),
    });
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="ایستگاه بسته‌بندی" />
        <PermissionNotice permission={PERM.packRead} />
      </>
    );
  }

  const board = boardQuery.data;
  const tasks = board?.tasks ?? [];
  const diagnostics = board?.diagnostics;
  const summary = board?.summary;
  const tableReady = board?.tableReady ?? true;

  const columns: readonly Column<PackTask>[] = [
    {
      key: 'order',
      header: 'سفارش',
      render: (task) => (
        <div>
          <p className="font-medium text-slate-900 dark:text-slate-100">{task.orderNo ?? '—'}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {FULFILLMENT_LABELS[task.fulfillmentStatus] ?? task.fulfillmentStatus}
          </p>
        </div>
      ),
    },
    {
      key: 'package',
      header: 'بسته',
      render: (task) => (
        <span className="text-xs text-slate-700 dark:text-slate-200" dir="ltr">
          {task.packageNo ?? '—'}
        </span>
      ),
    },
    {
      key: 'items',
      header: 'اقلام',
      align: 'end',
      render: (task) => (
        <div className="tabular">
          <p className="text-slate-800 dark:text-slate-100">{formatQuantity(task.totalQuantity)}</p>
          <p className="text-[11px] text-slate-500">{formatNumber(task.itemCount)} قلم</p>
        </div>
      ),
    },
    {
      key: 'assignee',
      header: 'مسئول',
      render: (task) =>
        task.assignedToName === null ? (
          <Badge tone="warning">بدون مسئول</Badge>
        ) : (
          <span className="text-xs text-slate-700 dark:text-slate-200">{task.assignedToName}</span>
        ),
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (task) => packStatusBadge(task.status),
    },
    {
      key: 'age',
      header: 'عمر',
      align: 'end',
      render: (task) => <span className="text-xs text-slate-500">{ageLabel(task.ageMinutes)}</span>,
    },
    {
      key: 'actions',
      header: 'عملیات',
      align: 'end',
      render: (task) => (
        <div className="flex justify-end gap-1.5">
          {task.status === 'pending' && (
            <Button
              size="sm"
              icon={<Play className="size-4" />}
              disabled={!canExecute}
              loading={startMutation.isPending && startMutation.variables === task.id}
              onClick={() => startMutation.mutate(task.id)}
            >
              شروع
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            icon={<PackageCheck className="size-4" />}
            disabled={!canExecute}
            onClick={() => openComplete(task)}
          >
            تکمیل
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="ایستگاه بسته‌بندی"
        description="تأیید بسته، ثبت شمارهٔ بسته و وزن، و اعلام آمادگی ارسال سفارش"
        actions={
          <>
            <Badge tone="neutral">به‌روزرسانی هر ۱۵ ثانیه</Badge>
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw className="size-4" />}
              loading={boardQuery.isFetching}
              onClick={() => void boardQuery.refetch()}
            >
              بازخوانی
            </Button>
          </>
        }
      />

      {boardQuery.isError && (
        <div className="mb-4">
          <ErrorState error={boardQuery.error} onRetry={() => void boardQuery.refetch()} />
        </div>
      )}

      {!canExecute && (
        <Card padding="sm" className="mb-4 border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            شما مجوز <code dir="ltr">warehouse.pack</code> را ندارید؛ صف بسته‌بندی را می‌بینید اما شروع و
            تکمیل بسته برای شما فعال نیست. برای دریافت مجوز با مدیر سامانه تماس بگیرید.
          </p>
        </Card>
      )}

      {!tableReady && (
        <Card className="mb-4 border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                جدول تسک‌های بسته‌بندی ساخته نشده است
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                {board?.warning ??
                  'مهاجرت جدول erp.pack_tasks باید اعمال شود؛ تا آن زمان ایستگاه بسته‌بندی خالی می‌ماند.'}
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="وظایف باز"
          value={formatNumber(summary?.openTasks ?? 0)}
          hint="آمادهٔ بسته‌بندی"
          icon={<PackageCheck className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="در انتظار شروع"
          value={formatNumber(summary?.pending ?? 0)}
          hint="بدون شروع بسته‌بندی"
          tone="warning"
          icon={<Play className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="در حال بسته‌بندی"
          value={formatNumber(summary?.packing ?? 0)}
          hint={`قدیمی‌ترین کار: ${ageLabel(summary?.oldestAgeMinutes ?? 0)}`}
          tone="brand"
          icon={<Scale className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="بسته‌بندی‌شده"
          value={formatNumber(summary?.packed ?? 0)}
          hint="سفارش‌های آمادهٔ ارسال"
          tone="success"
          icon={<Truck className="size-5" />}
          loading={boardQuery.isLoading}
        />
      </div>

      {diagnostics !== undefined && (
        <Card padding="sm" className="mb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
            <span>
              کل تسک‌های بسته‌بندی:{' '}
              <strong className="tabular">{formatNumber(diagnostics.tasksTotal)}</strong>
            </span>
            <span>
              در انتظار: <strong className="tabular">{formatNumber(diagnostics.pending)}</strong>
            </span>
            <span>
              در حال انجام: <strong className="tabular">{formatNumber(diagnostics.packing)}</strong>
            </span>
            <span>
              بسته‌بندی‌شده: <strong className="tabular">{formatNumber(diagnostics.packed)}</strong>
            </span>
            <span>
              سفارش برداشت‌شده:{' '}
              <strong className="tabular">{formatNumber(diagnostics.pickedOrders)}</strong>
            </span>
            <span>
              وظیفهٔ برداشت تکمیل‌شده:{' '}
              <strong className="tabular">{formatNumber(diagnostics.pickedTasks)}</strong>
            </span>
          </div>
          {diagnostics.pickedOrdersWithoutPackTask > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {formatNumber(diagnostics.pickedOrdersWithoutPackTask)} سفارش برداشت‌شده تسک بسته‌بندی ندارد؛
              این سفارش‌ها در ایستگاه دیده نمی‌شوند.
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title="صف بسته‌بندی"
          description="تسک‌های ساخته‌شده پس از تکمیل برداشت سفارش"
          actions={
            summary?.truncated === true ? <Badge tone="warning">فقط ۲۰۰ وظیفهٔ اول</Badge> : undefined
          }
        />
        {boardQuery.isLoading ? (
          <DataTable columns={columns} rows={[]} rowKey={(task) => task.id} loading />
        ) : !tableReady ? (
          <EmptyState
            icon={<AlertTriangle className="size-9 text-amber-500" />}
            title="ایستگاه بسته‌بندی در دسترس نیست"
            description="تا اعمال مهاجرت جدول erp.pack_tasks، امکان نمایش و تکمیل تسک‌های بسته‌بندی وجود ندارد."
          />
        ) : tasks.length === 0 && diagnostics !== undefined ? (
          <PackQueueEmptyState diagnostics={diagnostics} />
        ) : (
          <DataTable columns={columns} rows={tasks} rowKey={(task) => task.id} stickyHeader />
        )}
      </Card>

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title="تکمیل بسته‌بندی"
        description={
          target === null
            ? undefined
            : `سفارش ${target.orderNo ?? '—'} · ${formatNumber(target.itemCount)} قلم`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setTarget(null)}>
              انصراف
            </Button>
            <Button
              loading={completeMutation.isPending}
              icon={<CheckCircle2 className="size-4" />}
              onClick={submitComplete}
            >
              مهر و موم و اعلام آمادگی ارسال
            </Button>
          </>
        }
      >
        {target !== null && (
          <div className="space-y-4">
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              با تأیید، وضعیت سفارش به «آمادهٔ ارسال» تغییر می‌کند و در صورت پشتیبانی کانال، اطلاع‌رسانی
              آمادهٔ ارسال به‌صورت خودکار انجام می‌شود.
            </p>
            <FormField label="شمارهٔ بسته" hint="خالی بماند، شمارهٔ پیشنهادی سامانه ثبت می‌شود.">
              <Input
                dir="ltr"
                className="text-left"
                value={packageNo}
                onChange={(event) => setPackageNo(event.target.value)}
                placeholder="ORD-1001-P1"
              />
            </FormField>
            <FormField label="وزن بسته (گرم)" hint="اختیاری؛ در یادداشت تسک ذخیره می‌شود.">
              <NumberInput value={weight} onChange={setWeight} min="0" ariaLabel="وزن بسته به گرم" />
            </FormField>
            {formError !== null && <ErrorState message={formError} />}
          </div>
        )}
      </Modal>
    </>
  );
}
