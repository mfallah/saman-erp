import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PackageCheck, ScanLine, Weight, WifiOff } from 'lucide-react';
import { api, isNotImplemented, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useStationScans } from '../lib/use-scan-queue';
import { useHasPermission } from '../lib/use-auth';
import type { PackingStation, PackingTask } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { BarcodeInput } from '../components/ui/BarcodeInput';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Modal } from '../components/ui/Modal';
import { NumberInput } from '../components/ui/NumberInput';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';

function generateEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mobile-first packing station: anti-mispack verification by scanning the
 * order, then each product; optional scale weight; seal & produce label.
 */
export function PackingPage() {
  useDocumentTitle('ایستگاه بسته‌بندی');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.packRead);
  const canExecute = useHasPermission(PERM.packExecute);
  const station = useStationScans();
  const [status, setStatus] = useState('assigned');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [stage, setStage] = useState<'order' | 'product' | 'package'>('order');
  const [barcode, setBarcode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [weightGrams, setWeightGrams] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [stationId, setStationId] = useState('');

  const stationsQuery = useQuery({
    queryKey: queryKeys.fulfillment.packingStations,
    queryFn: () => api.get<readonly PackingStation[]>('/packing-stations', { perPage: 50 }),
    enabled: startOpen,
    staleTime: 5 * 60_000,
  });

  const tasksQuery = useQuery({
    queryKey: queryKeys.fulfillment.packingTasks({ status }),
    queryFn: () =>
      api.getPage<PackingTask>('/packing-tasks', {
        limit: 30,
        'filter[status]': status,
      }),
    enabled: canRead,
    refetchInterval: station.online ? 30_000 : false,
  });

  const taskQuery = useQuery({
    queryKey: queryKeys.fulfillment.packingTask(selectedTaskId ?? ''),
    queryFn: () => api.get<PackingTask>(`/packing-tasks/${selectedTaskId ?? ''}`, { include: 'items,verifications' }),
    enabled: canRead && selectedTaskId !== null,
  });

  const invalidate = (): void => {
    if (selectedTaskId !== null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fulfillment.packingTask(selectedTaskId) });
    }
    void queryClient.invalidateQueries({ queryKey: ['packing-tasks'] });
  };

  const startMutation = useMutation({
    mutationFn: () => api.post<PackingTask>(`/packing-tasks/${selectedTaskId ?? ''}/start`, { stationId }),
    onSuccess: () => {
      toast.success('بسته‌بندی آغاز شد');
      setStartOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('شروع بسته‌بندی ناموفق بود', toFaErrorMessage(error)),
  });

  const completeMutation = useMutation({
    mutationFn: () => api.post<PackingTask>(`/packing-tasks/${selectedTaskId ?? ''}/complete`, {}),
    onSuccess: () => {
      toast.success('بسته مهر و موم شد', 'برچسب ارسال در صف چاپ قرار گرفت.');
      setSelectedTaskId(null);
      invalidate();
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'تولید برچسب ارسال هنوز فعال نشده است.');
      } else {
        toast.error('تکمیل بسته‌بندی ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  const weightMutation = useMutation({
    mutationFn: () =>
      api.post<{ withinTolerance?: boolean }>(`/packing-tasks/${selectedTaskId ?? ''}/weight`, {
        weightGrams: weightGrams === '' ? 0 : Number(weightGrams),
        eventId: generateEventId(),
      }),
    onSuccess: (result) => {
      if (result.withinTolerance === false) {
        toast.warning('وزن با مقدار مورد انتظار اختلاف دارد', 'بسته برای بازبینی دستی علامت‌گذاری شد.');
      } else {
        toast.success('وزن ثبت شد');
      }
      setWeightGrams('');
      invalidate();
    },
    onError: (error) => toast.error('ثبت وزن ناموفق بود', toFaErrorMessage(error)),
  });

  const submitScan = async (): Promise<void> => {
    if (selectedTaskId === null) {
      return;
    }
    if (barcode.trim() === '') {
      setScanError('بارکد را اسکن کنید.');
      return;
    }
    setScanError(null);
    try {
      const result = await station.submit(`/packing-tasks/${selectedTaskId}/scans`, {
        eventId: generateEventId(),
        barcode: barcode.trim(),
        stage,
        ...(quantity === '' ? {} : { quantity }),
      });
      if (result.outcome === 'queued') {
        toast.warning('اسکن در صف آفلاین', 'پس از برقراری اتصال ارسال می‌شود.');
      } else {
        toast.success('تأیید بسته‌بندی انجام شد');
      }
      setBarcode('');
      setQuantity('');
      if (stage === 'order') {
        setStage('product');
      }
      invalidate();
    } catch (error) {
      setScanError(toFaErrorMessage(error));
    }
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="ایستگاه بسته‌بندی" />
        <PermissionNotice permission={PERM.packRead} />
      </>
    );
  }

  const tasks = tasksQuery.data?.items ?? [];
  const task = taskQuery.data;
  const expectedItems = task?.expectedItems ?? [];

  return (
    <>
      <PageHeader
        title="ایستگاه بسته‌بندی"
        description="تأیید دومرحله‌ای بسته پیش از حمل"
        actions={
          station.queuedCount > 0 ? (
            <Badge tone="warning">
              <WifiOff aria-hidden className="size-3.5" />
              {formatNumber(station.queuedCount)} اسکن در صف
            </Badge>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="کارهای بسته‌بندی" />
          <Tabs
            ariaLabel="وضعیت کارهای بسته‌بندی"
            value={status}
            onChange={setStatus}
            items={[
              { value: 'assigned', label: 'در انتظار' },
              { value: 'in_progress', label: 'در حال انجام' },
            ]}
          />
          <div className="mt-3 space-y-2">
            {tasksQuery.isLoading && <p className="text-sm text-slate-500">در حال دریافت…</p>}
            {tasksQuery.isError && (
              <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />
            )}
            {tasksQuery.data !== undefined && tasks.length === 0 && (
              <EmptyState
                icon={<PackageCheck className="size-9" />}
                title="کاری در صف بسته‌بندی نیست"
                description="پس از تکمیل برداشت، کارهای بسته‌بندی در این بخش ظاهر می‌شوند."
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
                      if (item.status === 'assigned') {
                        setStartOpen(false);
                      }
                    }}
                    className={`w-full rounded-xl border p-3 text-start transition-colors ${
                      selectedTaskId === item.id
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                        : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {item.orderNumber ?? item.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="تأیید بسته"
            description={task === undefined ? 'یک کار را انتخاب کنید' : `سفارش ${task.orderNumber ?? task.id.slice(0, 8)}`}
            actions={
              task !== undefined && canExecute && task.status === 'assigned' ? (
                <Button size="sm" onClick={() => setStartOpen(true)} icon={<ScanLine className="size-4" />}>
                  شروع بسته‌بندی
                </Button>
              ) : undefined
            }
          />

          {task === undefined ? (
            <EmptyState
              icon={<PackageCheck className="size-9" />}
              title="کاری انتخاب نشده است"
              description="از فهرست کنار، یک کار بسته‌بندی را انتخاب کنید."
            />
          ) : (
            <div className="space-y-4">
              {expectedItems.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800">
                  {expectedItems.map((item, index) => (
                    <li key={`${item.barcode ?? index}`} className="flex items-center justify-between gap-2">
                      <span dir="ltr">{item.barcode ?? item.sku ?? '—'}</span>
                      <span className="tabular">{formatNumber(item.quantity, 2)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <Tabs
                ariaLabel="مرحله اسکن"
                value={stage}
                onChange={(value) => setStage(value === 'product' ? 'product' : value === 'package' ? 'package' : 'order')}
                items={[
                  { value: 'order', label: '۱. اسکن سفارش' },
                  { value: 'product', label: '۲. اسکن کالا' },
                  { value: 'package', label: '۳. اسکن بسته' },
                ]}
              />
              <BarcodeInput
                onScan={(code) => setBarcode(code)}
                label="بارکد"
                hint="بارکد را اسکن کنید یا با Enter تأیید کنید."
                disabled={!canExecute || task.status === 'completed'}
              />
              <FormField label="تعداد (اختیاری)">
                <NumberInput value={quantity} onChange={setQuantity} min="0" />
              </FormField>
              {scanError !== null && <ErrorState message={scanError} />}
              <Button
                block
                size="lg"
                onClick={() => void submitScan()}
                disabled={!canExecute || task.status === 'completed'}
                icon={<CheckCircle2 className="size-5" />}
              >
                تأیید اسکن
              </Button>

              <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <p className="mb-2 flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <Weight aria-hidden className="size-4" />
                  ثبت وزن بسته (گرم)
                </p>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <NumberInput value={weightGrams} onChange={setWeightGrams} min="0" ariaLabel="وزن بسته به گرم" />
                  </div>
                  <Button
                    variant="outline"
                    loading={weightMutation.isPending}
                    disabled={weightGrams === '' || !canExecute}
                    onClick={() => weightMutation.mutate()}
                  >
                    ثبت وزن
                  </Button>
                </div>
              </div>

              <Button
                block
                size="lg"
                variant="primary"
                loading={completeMutation.isPending}
                disabled={!canExecute || task.status !== 'in_progress'}
                onClick={() => completeMutation.mutate()}
              >
                مهر و موم و تولید برچسب
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="شروع بسته‌بندی"
        description="ایستگاه بسته‌بندی را انتخاب کنید."
        footer={
          <>
            <Button variant="outline" onClick={() => setStartOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={startMutation.isPending}
              disabled={stationId === ''}
              onClick={() => startMutation.mutate()}
            >
              شروع
            </Button>
          </>
        }
      >
        <FormField label="ایستگاه بسته‌بندی" required>
          <Select
            options={(stationsQuery.data ?? []).map((stationRow) => ({
              value: stationRow.id,
              label: stationRow.name,
            }))}
            value={stationId}
            loading={stationsQuery.isLoading}
            placeholder="انتخاب ایستگاه"
            onChange={(event) => setStationId(event.target.value)}
          />
        </FormField>
        {stationsQuery.isError && (
          <div className="mt-2">
            <ErrorState message="دریافت ایستگاه‌ها ناموفق بود." onRetry={() => void stationsQuery.refetch()} />
          </div>
        )}
        {stationsQuery.data !== undefined && stationsQuery.data.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">ایستگاهی ثبت نشده است؛ با مدیر انبار تماس بگیرید.</p>
        )}
      </Modal>
    </>
  );
}
