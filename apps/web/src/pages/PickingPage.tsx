import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ListChecks, MapPin, PackageSearch, Play, WifiOff } from 'lucide-react';
import { api, isNotImplemented, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useStationScans } from '../lib/use-scan-queue';
import { useHasPermission } from '../lib/use-auth';
import type { PickTask } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { BarcodeInput } from '../components/ui/BarcodeInput';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { NumberInput } from '../components/ui/NumberInput';
import { PageHeader } from '../components/ui/PageHeader';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';

function generateEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mobile-first picking station: task queue → start → two-stage scan
 * verification (location + barcode) → quantity confirm → complete.
 * Scans are queued offline and replayed idempotently (ADR-0011).
 */
export function PickingPage() {
  useDocumentTitle('ایستگاه برداشت');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.pickRead);
  const canExecute = useHasPermission(PERM.pickExecute);
  const station = useStationScans();
  const [status, setStatus] = useState('assigned');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [barcode, setBarcode] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: queryKeys.fulfillment.pickTasks({ status }),
    queryFn: () =>
      api.getPage<PickTask>('/pick-tasks', {
        limit: 30,
        'filter[status]': status,
      }),
    enabled: canRead,
    refetchInterval: station.online ? 30_000 : false,
  });

  const taskQuery = useQuery({
    queryKey: queryKeys.fulfillment.pickTask(selectedTaskId ?? ''),
    queryFn: () => api.get<PickTask>(`/pick-tasks/${selectedTaskId ?? ''}`),
    enabled: canRead && selectedTaskId !== null,
  });

  const invalidateTask = (): void => {
    if (selectedTaskId !== null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fulfillment.pickTask(selectedTaskId) });
    }
    void queryClient.invalidateQueries({ queryKey: ['pick-tasks'] });
  };

  const startMutation = useMutation({
    mutationFn: (taskId: string) => api.post<PickTask>(`/pick-tasks/${taskId}/start`, {}),
    onSuccess: (task) => {
      setSelectedTaskId(task.id);
      toast.success('برداشت آغاز شد', 'کارت برداشت برای شما قفل شد.');
      invalidateTask();
    },
    onError: (error) => toast.error('شروع برداشت ناموفق بود', toFaErrorMessage(error)),
  });

  const completeMutation = useMutation({
    mutationFn: (taskId: string) => api.post<PickTask>(`/pick-tasks/${taskId}/complete`, {}),
    onSuccess: () => {
      toast.success('برداشت تکمیل شد');
      setSelectedTaskId(null);
      invalidateTask();
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'این عملیات هنوز فعال نشده است.');
      } else {
        toast.error('تکمیل برداشت ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  const submitScan = async (): Promise<void> => {
    if (selectedTaskId === null) {
      return;
    }
    if (barcode.trim() === '') {
      setScanError('بارکد کالا را اسکن کنید.');
      return;
    }
    setScanError(null);
    try {
      const result = await station.submit(`/pick-tasks/${selectedTaskId}/scans`, {
        eventId: generateEventId(),
        barcode: barcode.trim(),
        ...(locationCode.trim() === '' ? {} : { locationCode: locationCode.trim() }),
        quantity: quantity === '' ? '0' : quantity,
      });
      if (result.outcome === 'queued') {
        toast.warning('اسکن در صف آفلاین', 'به‌محض برقراری اتصال، اسکن‌ها به سرور ارسال می‌شوند.');
      } else {
        toast.success('اسکن تأیید شد');
      }
      setBarcode('');
      setLocationCode('');
      setQuantity('');
      invalidateTask();
    } catch (error) {
      setScanError(toFaErrorMessage(error));
    }
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="ایستگاه برداشت" />
        <PermissionNotice permission={PERM.pickRead} />
      </>
    );
  }

  const tasks = tasksQuery.data?.items ?? [];
  const task = taskQuery.data;
  const lines = task?.lines ?? [];

  return (
    <>
      <PageHeader
        title="ایستگاه برداشت"
        description="اسکن موقعیت و بارکد کالا برای برداشت مطمئن"
        actions={
          station.queuedCount > 0 ? (
            <Badge tone="warning">
              <WifiOff aria-hidden className="size-3.5" />
              {formatNumber(station.queuedCount)} اسکن در صف
            </Badge>
          ) : undefined
        }
      />

      {!station.online && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          اتصال شبکه قطع است؛ اسکن‌ها به‌صورت امن در همین دستگاه ذخیره و پس از اتصال ارسال می‌شوند.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="کارهای برداشت" description="کارهای اختصاص‌یافته به شما یا ایستگاه" />
          <Tabs
            ariaLabel="وضعیت کارهای برداشت"
            value={status}
            onChange={(value) => setStatus(value)}
            items={[
              { value: 'assigned', label: 'اختصاص‌یافته' },
              { value: 'in_progress', label: 'در حال انجام' },
            ]}
          />
          <div className="mt-3">
            {tasksQuery.isLoading && <p className="text-sm text-slate-500">در حال دریافت…</p>}
            {tasksQuery.isError && (
              <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />
            )}
            {tasksQuery.data !== undefined && tasks.length === 0 && (
              <EmptyState
                icon={<ListChecks className="size-9" />}
                title="کاری در این صف نیست"
                description="پس از برنامه‌ریزی موج برداشت، کارها برای شما نمایش داده می‌شوند."
              />
            )}
            <ul className="space-y-2">
              {tasks.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTaskId(item.id);
                      setScanError(null);
                    }}
                    className={`w-full rounded-xl border p-3 text-start transition-colors ${
                      selectedTaskId === item.id
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                        : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                        {item.orderNumber ?? item.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {item.lines === undefined ? 'اقلام پس از انتخاب نمایش داده می‌شوند.' : `${formatNumber(item.lines.length)} قلم`}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="اسکن برداشت"
            description={task === undefined ? 'یک کار را از فهرست انتخاب کنید' : `سفارش ${task.orderNumber ?? task.id.slice(0, 8)}`}
            actions={
              task !== undefined && canExecute && task.status === 'assigned' ? (
                <Button
                  size="sm"
                  icon={<Play className="size-4" />}
                  loading={startMutation.isPending}
                  onClick={() => startMutation.mutate(task.id)}
                >
                  شروع
                </Button>
              ) : undefined
            }
          />

          {taskQuery.isError && <ErrorState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />}

          {task === undefined ? (
            <EmptyState
              icon={<PackageSearch className="size-9" />}
              title="کاری انتخاب نشده است"
              description="از فهرست کنار، یک کار برداشت را انتخاب کنید."
            />
          ) : (
            <div className="space-y-4">
              {lines.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800">
                  {lines.map((line) => (
                    <li key={line.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        {line.variant?.name ?? line.sku ?? 'کالا'}
                        {line.location?.code !== undefined && (
                          <span dir="ltr" className="ms-1 text-slate-400">
                            <MapPin aria-hidden className="inline size-3" /> {line.location.code}
                          </span>
                        )}
                      </span>
                      <span className="tabular text-slate-600 dark:text-slate-300">
                        {formatNumber(line.requestedQuantity, 2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <BarcodeInput
                onScan={(code) => setBarcode(code)}
                label="بارکد کالا"
                hint="بارکد کالا را اسکن کنید یا وارد کنید."
                disabled={!canExecute || task.status === 'completed'}
              />
              <FormField label="کد موقعیت (اختیاری)">
                <Input
                  dir="ltr"
                  className="text-left"
                  value={locationCode}
                  onChange={(event) => setLocationCode(event.target.value)}
                  placeholder="TEH-A-03-02-01"
                />
              </FormField>
              <FormField label="مقدار برداشت">
                <NumberInput value={quantity} onChange={setQuantity} min="0" />
              </FormField>

              {scanError !== null && <ErrorState message={scanError} />}
              {taskQuery.isError && <ErrorState error={taskQuery.error} />}

              <div className="sticky bottom-2 flex flex-col gap-2 rounded-xl bg-white/95 pt-2 sm:flex-row dark:bg-slate-900/95">
                <Button
                  block
                  size="lg"
                  onClick={() => void submitScan()}
                  disabled={!canExecute || task.status === 'completed'}
                  icon={<CheckCircle2 className="size-5" />}
                >
                  تأیید اسکن
                </Button>
                <Button
                  block
                  size="lg"
                  variant="outline"
                  loading={completeMutation.isPending}
                  onClick={() => completeMutation.mutate(task.id)}
                  disabled={!canExecute || task.status !== 'in_progress'}
                >
                  تکمیل برداشت
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
