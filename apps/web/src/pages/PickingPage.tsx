import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Barcode,
  Camera,
  CheckCircle2,
  ListChecks,
  MapPin,
  Play,
  RefreshCw,
  ScanBarcode,
  Users,
} from 'lucide-react';
import { api, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber, formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  CompletePickTaskResult,
  MyPickTask,
  PickBoardDiagnostics,
  PickBoardOrder,
  PickBoardTask,
  PickScanResult,
  PickTaskBoard,
} from '../types/api';
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

/** Task statuses of the pick flow, in Persian. */
const PICK_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'در انتظار', tone: 'warning' },
  in_progress: { label: 'در حال برداشت', tone: 'info' },
  picked: { label: 'برداشت‌شده', tone: 'success' },
  short: { label: 'برداشت کوتاه', tone: 'danger' },
  cancelled: { label: 'لغو‌شده', tone: 'neutral' },
  exception: { label: 'استثنا', tone: 'danger' },
};

/** Channel chips the picker sees on each line. */
function channelLabel(code: string | null | undefined): string {
  const normalized = (code ?? '').toLowerCase();
  if (normalized === 'digikala') return 'دیجی‌کالا';
  if (normalized === 'carexy') return 'کرکسی';
  return code ?? '—';
}

function channelTone(code: string | null | undefined): BadgeTone {
  const normalized = (code ?? '').toLowerCase();
  if (normalized === 'digikala') return 'danger';
  if (normalized === 'carexy') return 'info';
  return 'neutral';
}

/** Normalized shape used by the scan / completion dialog for both feeds. */
interface PickTarget {
  readonly id: string;
  readonly orderNo: string | null;
  readonly channelCode: string | null;
  readonly productName: string | null;
  readonly variantSku: string | null;
  readonly imageUrl: string | null;
  readonly locationCode: string | null;
  readonly quantityRequired: string;
  readonly quantityPicked: string;
}

function statusBadge(status: string) {
  const meta = PICK_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function ageLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'همین حالا';
  if (minutes < 60) return `${formatNumber(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${formatNumber(hours)} ساعت`;
  return `${formatNumber(Math.floor(hours / 24))} روز`;
}

function targetFromBoardTask(task: PickBoardTask): PickTarget {
  return {
    id: task.id,
    orderNo: task.orderNo,
    channelCode: task.channelCode ?? null,
    productName: task.productName ?? task.title,
    variantSku: task.variantSku ?? task.sku,
    imageUrl: task.imageUrl ?? null,
    locationCode: task.locationCode,
    quantityRequired: task.quantityRequired,
    quantityPicked: task.quantityPicked,
  };
}

function targetFromMyTask(task: MyPickTask): PickTarget {
  return {
    id: task.id,
    orderNo: task.orderNo ?? null,
    channelCode: task.channelCode ?? null,
    productName: task.productName ?? task.title ?? null,
    variantSku: task.variantSku ?? task.sku ?? null,
    imageUrl: task.imageUrl ?? null,
    locationCode: task.locationCode,
    quantityRequired: task.quantityRequired ?? task.quantity,
    quantityPicked: task.quantityPicked ?? '0',
  };
}

/** 48px product thumbnail with a barcode placeholder when no image exists. */
function ProductThumb({ src, alt }: { readonly src: string | null | undefined; readonly alt: string }) {
  const [failed, setFailed] = useState(false);
  if (src === undefined || src === null || src.length === 0 || failed) {
    return (
      <span
        aria-hidden
        className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400 dark:bg-slate-800"
      >
        <Barcode className="size-6" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-12 shrink-0 rounded-lg object-cover"
    />
  );
}

// ------------------------------------------------------------- camera scan

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<readonly { rawValue: string }[]>;
};
type BarcodeDetectorCtor = new (options?: { formats?: readonly string[] }) => BarcodeDetectorLike;

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] as const;

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const candidate = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

function cameraAvailable(): boolean {
  return (
    getBarcodeDetectorCtor() !== null &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia !== undefined
  );
}

/**
 * Camera preview that auto-detects a barcode with the native `BarcodeDetector`.
 * The text field in the scan dialog stays the always-available fallback, so a
 * missing camera never blocks picking.
 */
function CameraScanPane({
  active,
  onDetected,
}: {
  readonly active: boolean;
  readonly onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!active) {
      setScanning(false);
      return;
    }
    setError(null);
    const ctor = getBarcodeDetectorCtor();
    if (ctor === null) {
      setError('مرورگر از تشخیص خودکار بارکد پشتیبانی نمی‌کند؛ ۳ رقم آخر بارکد را وارد کنید.');
      return;
    }
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined || mediaDevices.getUserMedia === undefined) {
      setError('دوربین در این مرورگر در دسترس نیست؛ ۳ رقم آخر بارکد را وارد کنید.');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stream: MediaStream | null = null;
    let detector: BarcodeDetectorLike | null = null;
    const stopStream = (): void => {
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
    };
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video !== null && detector !== null && video.readyState >= 2) {
        try {
          const codes = await detector.detect(video);
          const value = codes[0]?.rawValue?.trim() ?? '';
          if (!cancelled && value.length > 0) {
            if (typeof navigator.vibrate === 'function') navigator.vibrate(80);
            onDetectedRef.current(value);
            // Keep the camera alive for the next task in the queue: the station
            // auto-advances, so the operator can scan the following item at once.
            timer = setTimeout(() => void tick(), 1_500);
            return;
          }
        } catch {
          // Transient detection errors while the frame warms up are normal.
        }
      }
      timer = setTimeout(() => void tick(), 250);
    };
    void (async () => {
      try {
        stream = await mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        detector = new ctor({ formats: BARCODE_FORMATS });
        setScanning(true);
        timer = setTimeout(() => void tick(), 400);
      } catch (cause) {
        const name = cause instanceof DOMException ? cause.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'اجازهٔ دسترسی به دوربین داده نشد؛ ۳ رقم آخر بارکد را وارد کنید.'
            : name === 'NotFoundError'
              ? 'دوربینی پیدا نشد؛ ۳ رقم آخر بارکد را وارد کنید.'
              : 'بازکردن دوربین ناموفق بود؛ ۳ رقم آخر بارکد را وارد کنید.',
        );
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      stopStream();
      setScanning(false);
    };
  }, [active]);

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-xl bg-slate-950">
        <video ref={videoRef} muted playsInline className="aspect-[4/3] w-full object-cover" />
        {scanning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-32 w-4/5 rounded-lg border-2 border-brand-400/80 shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]" />
          </div>
        )}
        {!scanning && error === null && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
            در حال روشن‌کردن دوربین…
          </div>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** Order-level progress: completed lines of every order on the board. */
function OrderProgress({ orders }: { readonly orders: readonly PickBoardOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <Card className="mb-4">
      <CardHeader
        title="پیشرفت سفارش‌ها"
        description="هر سفارش وقتی به ایستگاه بسته‌بندی می‌رود که همهٔ قلم‌هایش برداشت شده باشد"
        actions={<Badge tone="info">{formatNumber(orders.length)} سفارش</Badge>}
      />
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {orders.map((order) => {
          const done = Math.max(0, order.taskCount - order.openCount);
          const percent = order.taskCount === 0 ? 0 : Math.round((done / order.taskCount) * 100);
          const channel = order.tasks[0]?.channelCode ?? null;
          return (
            <li key={order.orderId} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {order.orderNo ?? '—'}
                </p>
                <Badge tone={channelTone(channel)}>{channelLabel(channel)}</Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {formatNumber(done)} از {formatNumber(order.taskCount)} قلم برداشت‌شده
              </p>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`پیشرفت سفارش ${order.orderNo ?? ''}`}
              >
                <div
                  className={`h-full rounded-full ${percent === 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Explains exactly why the picking queue is empty, using the board's
 * diagnostics: no order lines, no pickable warehouse/location, no active picker
 * or simply nothing left to do.
 */
function PickQueueEmptyState({
  diagnostics,
  backfillAction,
}: {
  readonly diagnostics: PickBoardDiagnostics;
  readonly backfillAction?: ReactNode;
}) {
  if (diagnostics.tasksTotal === 0) {
    if (diagnostics.activePickers === 0 && diagnostics.fallbackPickers === 0) {
      return (
        <EmptyState
          icon={<Users className="size-9" />}
          title="هیچ نیروی انبار فعالی برای تخصیص وجود ندارد"
          description="کاربر فعالی با نقش «انبار» یا «مدیر» در این سازمان ثبت نشده است. تا زمان افزودن کاربر، تسک‌های برداشت بدون مسئول ساخته می‌شوند."
        />
      );
    }
    if (diagnostics.warehouses === 0) {
      return (
        <EmptyState
          icon={<MapPin className="size-9" />}
          title="هنوز انباری برای این سازمان ثبت نشده است"
          description="بدون انبار و مکان قابل‌برداشت، تسک برداشت ساخته نمی‌شود. ابتدا انبار و مکان‌های آن را تعریف کنید."
        />
      );
    }
    if (diagnostics.ordersTotal === 0) {
      return (
        <EmptyState
          icon={<ListChecks className="size-9" />}
          title="هنوز سفارشی ثبت نشده است"
          description="به‌محض ثبت سفارش و قلم‌های آن، وظایف برداشت به‌صورت خودکار ساخته و بین نیروهای انبار تقسیم می‌شوند."
        />
      );
    }
    if (diagnostics.ordersWithLines === 0) {
      return (
        <EmptyState
          icon={<AlertTriangle className="size-9 text-amber-500" />}
          title="سفارش‌ها قلم ندارند"
          description={`${formatNumber(diagnostics.ordersTotal)} سفارش ثبت شده اما هیچ‌کدام قلم ندارند؛ بدون قلم، وظیفه برداشت ساخته نمی‌شود.`}
        />
      );
    }
    if (diagnostics.ordersWithoutTasks > 0) {
      return (
        <EmptyState
          icon={<AlertTriangle className="size-9 text-amber-500" />}
          title={`${formatNumber(diagnostics.ordersWithoutTasks)} سفارش قلم دارد ولی وظیفه برداشت ندارد`}
          description={
            diagnostics.ordersWithoutWarehouse > 0
              ? `${formatNumber(diagnostics.ordersWithoutWarehouse)} سفارش نه در سربرگ و نه در قلم‌ها انبار ندارد؛ برای آن‌ها انبار تعیین کنید تا وظیفه برداشت ساخته شود.`
              : 'علت احتمالی: نبود مکان قابل‌برداشت در انبار سفارش. مکان‌های انبار را بررسی کنید.'
          }
          {...(backfillAction === undefined ? {} : { action: backfillAction })}
        />
      );
    }
    return (
      <EmptyState
        icon={<ListChecks className="size-9" />}
        title="صف برداشت خالی است"
        description="سفارش‌های تأییدشده پس از پردازش، وظیفه برداشت دریافت می‌کنند؛ چند لحظه بعد دوباره بررسی کنید."
      />
    );
  }
  return (
    <EmptyState
      icon={<CheckCircle2 className="size-9 text-emerald-500" />}
      title="همه وظایف برداشت انجام شده‌اند"
      description={`${formatNumber(diagnostics.tasksTotal)} وظیفه ثبت شده و هیچ وظیفهٔ بازی نمانده است. سفارش‌های کامل‌شده به ایستگاه بسته‌بندی منتقل می‌شوند.`}
    />
  );
}

/**
 * Picking station: summary counters, order-level progress, the open-task board
 * grouped by order, and barcode-first picking. «اسکن» opens the scan dialog
 * (camera first, last-3-digits fallback); a matching scan completes the task and
 * advances to the next one. Polls every 15 seconds so a shared station follows
 * the warehouse in near real time.
 */
export function PickingPage() {
  useDocumentTitle('ایستگاه برداشت');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.pickRead);
  const canExecute = useHasPermission(PERM.pickExecute);

  const [target, setTarget] = useState<PickTarget | null>(null);
  const [quantity, setQuantity] = useState('');
  const [barcode, setBarcode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [scanTarget, setScanTarget] = useState<PickTarget | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);

  const boardQuery = useQuery({
    queryKey: queryKeys.fulfillment.pickBoard,
    queryFn: () => api.get<PickTaskBoard>('/warehouse/pick-tasks/board'),
    enabled: canRead,
    refetchInterval: 15_000,
  });

  const mineQuery = useQuery({
    queryKey: queryKeys.fulfillment.myPickTasks,
    queryFn: () => api.get<readonly MyPickTask[]>('/warehouse/pick-tasks/mine'),
    enabled: canRead,
    refetchInterval: 15_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['pick-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['pack-tasks'] });
  };

  const startMutation = useMutation({
    mutationFn: (taskId: string) => api.post(`/warehouse/pick-tasks/${taskId}/start`, {}),
    onSuccess: () => {
      toast.success('برداشت آغاز شد', 'این وظیفه به نام شما ثبت شد.');
      invalidate();
    },
    onError: (error) => toast.error('شروع برداشت ناموفق بود', toFaErrorMessage(error)),
  });

  const backfillMutation = useMutation({
    mutationFn: () =>
      api.post<{ ordersChecked: number; tasksCreated: number }>('/warehouse/pick-tasks/backfill', {}),
    onSuccess: (result) => {
      if (result.tasksCreated > 0) {
        toast.success(
          'وظایف برداشت ساخته شد',
          `${formatNumber(result.ordersChecked)} سفارش بررسی و ${formatNumber(result.tasksCreated)} وظیفه ایجاد شد.`,
        );
      } else {
        toast.warning(
          'وظیفه‌ای ساخته نشد',
          'برای سفارش‌های باقی‌مانده انبار یا مکان قابل‌برداشت تعیین کنید.',
        );
      }
      invalidate();
    },
    onError: (error) => toast.error('ساخت وظایف برداشت ناموفق بود', toFaErrorMessage(error)),
  });

  const completeMutation = useMutation({
    mutationFn: (input: { taskId: string; quantityPicked: string; scannedBarcode?: string }) =>
      api.post<CompletePickTaskResult>(`/warehouse/pick-tasks/${input.taskId}/complete`, {
        quantityPicked: input.quantityPicked,
        ...(input.scannedBarcode === undefined ? {} : { scannedBarcode: input.scannedBarcode }),
      }),
    onSuccess: (result) => {
      setTarget(null);
      if (!result.orderComplete) {
        toast.success('وظیفه برداشت تکمیل شد');
      } else if (result.packTask !== null) {
        toast.success(
          'سفارش کامل برداشت شد',
          `تسک بسته‌بندی ${result.packTask.packageNo ?? ''} ساخته شد.`.trim(),
        );
      } else {
        toast.warning(
          'سفارش برداشت شد اما تسک بسته‌بندی ساخته نشد',
          'جدول pack_tasks یا قلم‌های سفارش را بررسی کنید؛ ایستگاه بسته‌بندی خالی می‌ماند.',
        );
      }
      invalidate();
    },
    onError: (error) => setFormError(toFaErrorMessage(error)),
  });

  const boardTasks = boardQuery.data?.tasks ?? [];

  const scanMutation = useMutation({
    mutationFn: (input: { taskId: string; barcode: string }) =>
      api.post<PickScanResult>(`/warehouse/pick-tasks/${input.taskId}/scan`, { barcode: input.barcode }),
    onSuccess: (result, input) => {
      const index = boardTasks.findIndex((task) => task.id === input.taskId);
      const next =
        boardTasks.slice(index + 1).find((task) => task.id !== input.taskId) ??
        boardTasks.find((task) => task.id !== input.taskId) ??
        null;
      if (result.orderComplete && result.packTask !== null) {
        toast.success(
          'سفارش کامل برداشت شد',
          `تسک بسته‌بندی ${result.packTask.packageNo ?? ''} ساخته شد.`.trim(),
        );
      } else if (result.orderComplete) {
        toast.warning(
          'سفارش برداشت شد اما تسک بسته‌بندی ساخته نشد',
          'جدول pack_tasks یا قلم‌های سفارش را بررسی کنید.',
        );
      } else {
        toast.success('اسکن تأیید شد', 'این قلم برداشت و به قلم بعدی منتقل شدید.');
      }
      invalidate();
      if (next !== null) {
        setScanTarget(targetFromBoardTask(next));
        setScanInput('');
        setScanError(null);
      } else {
        setScanTarget(null);
        setScanInput('');
        setScanError(null);
      }
    },
    onError: (error) => setScanError(toFaErrorMessage(error)),
  });

  const openComplete = (next: PickTarget): void => {
    setTarget(next);
    // Completion is a full pick; partial picks go through the short-pick flow.
    setQuantity(next.quantityRequired);
    setBarcode('');
    setFormError(null);
  };

  const openScan = (next: PickTarget): void => {
    setScanTarget(next);
    setScanInput('');
    setScanError(null);
  };

  const submitScan = (value?: string): void => {
    if (scanTarget === null) return;
    const code = (value ?? scanInput).trim();
    if (code.length === 0) {
      setScanError('بارکد یا ۳ رقم آخر آن را وارد کنید.');
      return;
    }
    setScanError(null);
    scanMutation.mutate({ taskId: scanTarget.id, barcode: code });
  };

  const submitComplete = (): void => {
    if (target === null) return;
    const trimmed = quantity.trim();
    if (trimmed === '' || !(Number(trimmed) > 0)) {
      setFormError('مقدار برداشت باید بزرگ‌تر از صفر باشد.');
      return;
    }
    setFormError(null);
    completeMutation.mutate({
      taskId: target.id,
      quantityPicked: trimmed,
      ...(barcode.trim() === '' ? {} : { scannedBarcode: barcode.trim() }),
    });
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="ایستگاه برداشت" />
        <PermissionNotice permission={PERM.pickRead} />
      </>
    );
  }

  const board = boardQuery.data;
  const tasks = boardTasks;
  const myTasks = mineQuery.data ?? [];
  const diagnostics = board?.diagnostics;
  const summary = board?.summary;

  const columns: readonly Column<PickBoardTask>[] = [
    {
      key: 'order',
      header: 'سفارش',
      render: (task) => (
        <div>
          <p className="font-medium text-slate-900 dark:text-slate-100">{task.orderNo ?? '—'}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone={channelTone(task.channelCode)}>{channelLabel(task.channelCode)}</Badge>
            {task.waveNo !== null && <Badge tone="neutral">موج {task.waveNo}</Badge>}
          </div>
        </div>
      ),
    },
    {
      key: 'item',
      header: 'کالا',
      render: (task) => (
        <div className="flex items-center gap-2.5">
          <ProductThumb src={task.imageUrl} alt={task.productName ?? task.title ?? 'کالا'} />
          <div className="min-w-0 max-w-56">
            <p className="truncate text-slate-800 dark:text-slate-100" dir="auto">
              {task.productName ?? task.title ?? 'بدون عنوان'}
            </p>
            <p className="text-[11px] text-slate-500" dir="ltr">
              {task.variantSku ?? task.sku ?? '—'}
            </p>
            <p className="text-[11px] text-slate-500">
              تعداد: <strong className="tabular">{formatQuantity(task.quantityRequired)}</strong>
              {' · '}
              برداشت‌شده: {formatQuantity(task.quantityPicked)}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'location',
      header: 'مکان',
      render: (task) =>
        task.locationCode === null ? (
          <span className="text-xs text-red-600">بدون مکان</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-slate-700 dark:text-slate-200">
            <MapPin aria-hidden className="size-3.5 text-slate-400" />
            <span dir="ltr">{task.locationCode}</span>
          </span>
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
      render: (task) => statusBadge(task.status),
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
              variant="outline"
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
            icon={<CheckCircle2 className="size-4" />}
            disabled={!canExecute}
            onClick={() => openComplete(targetFromBoardTask(task))}
          >
            تکمیل
          </Button>
          <Button
            size="sm"
            icon={<ScanBarcode className="size-4" />}
            disabled={!canExecute}
            loading={scanMutation.isPending && scanMutation.variables?.taskId === task.id}
            onClick={() => openScan(targetFromBoardTask(task))}
          >
            اسکن
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="ایستگاه برداشت"
        description="صف وظایف برداشت سفارش‌ها، اسکن بارکد کالا و ثبت مقدار برداشت"
        actions={
          <>
            <Badge tone="neutral">به‌روزرسانی هر ۱۵ ثانیه</Badge>
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw className="size-4" />}
              loading={boardQuery.isFetching}
              onClick={() => {
                void boardQuery.refetch();
                void mineQuery.refetch();
              }}
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
            شما مجوز <code dir="ltr">warehouse.pick</code> را ندارید؛ صف برداشت را می‌بینید اما شروع، اسکن و تکمیل
            وظیفه برای شما فعال نیست. برای دریافت مجوز با مدیر سامانه تماس بگیرید.
          </p>
        </Card>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="وظایف باز"
          value={formatNumber(summary?.openTasks ?? 0)}
          hint={`${formatNumber(summary?.orders ?? 0)} سفارش در صف`}
          icon={<ListChecks className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="در انتظار شروع"
          value={formatNumber(summary?.pending ?? 0)}
          hint="آمادهٔ برداشت"
          tone="warning"
          icon={<Play className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="در حال برداشت"
          value={formatNumber(summary?.inProgress ?? 0)}
          hint={`قدیمی‌ترین کار: ${ageLabel(summary?.oldestAgeMinutes ?? 0)}`}
          tone="brand"
          icon={<ScanBarcode className="size-5" />}
          loading={boardQuery.isLoading}
        />
        <StatCard
          title="بدون مسئول"
          value={formatNumber(summary?.unassigned ?? 0)}
          hint="با «شروع» به نام شما ثبت می‌شود"
          tone={summary !== undefined && summary.unassigned > 0 ? 'danger' : 'success'}
          icon={<Users className="size-5" />}
          loading={boardQuery.isLoading}
        />
      </div>

      <OrderProgress orders={board?.orders ?? []} />

      {diagnostics !== undefined && (
        <Card padding="sm" className="mb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
            <span>
              سفارش‌ها: <strong className="tabular">{formatNumber(diagnostics.ordersTotal)}</strong>
            </span>
            <span>
              دارای قلم: <strong className="tabular">{formatNumber(diagnostics.ordersWithLines)}</strong>
            </span>
            <span>
              بدون قلم: <strong className="tabular">{formatNumber(diagnostics.ordersWithoutLines)}</strong>
            </span>
            <span>
              آماده ولی بدون وظیفه:{' '}
              <strong className="tabular">{formatNumber(diagnostics.ordersWithoutTasks)}</strong>
            </span>
            <span>
              نیرو با مجوز برداشت:{' '}
              <strong className="tabular">{formatNumber(diagnostics.activePickers)}</strong>
            </span>
            <span>
              نیروی جایگزین (انبار/مدیر):{' '}
              <strong className="tabular">{formatNumber(diagnostics.fallbackPickers)}</strong>
            </span>
            <span>
              انبار فعال: <strong className="tabular">{formatNumber(diagnostics.warehouses)}</strong>
            </span>
          </div>
          {diagnostics.activePickers === 0 && diagnostics.fallbackPickers === 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              هیچ کاربر فعالی مجوز <code dir="ltr">warehouse.pick</code> ندارد و کاربری با نقش انبار/مدیر هم
              یافت نشد؛ تسک‌ها بدون مسئول ساخته می‌شوند.
            </p>
          )}
          {diagnostics.ordersWithoutTasks > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {formatNumber(diagnostics.ordersWithoutTasks)} سفارش با قلم، وظیفهٔ برداشت ندارد؛
                {diagnostics.ordersWithoutWarehouse > 0
                  ? ` ${formatNumber(diagnostics.ordersWithoutWarehouse)} سفارش انبار تعیین‌نشده دارد.`
                  : ' مکان قابل‌برداشت انبار را بررسی کنید.'}
              </p>
              {canExecute && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={backfillMutation.isPending}
                  onClick={() => backfillMutation.mutate()}
                >
                  ساخت وظایف برداشت
                </Button>
              )}
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="صف برداشت"
            description="همهٔ وظایف باز، مرتب بر اساس زمان ایجاد و ترتیب برداشت"
            actions={
              summary?.truncated === true ? <Badge tone="warning">فقط ۲۰۰ وظیفهٔ اول</Badge> : undefined
            }
          />
          {boardQuery.isLoading ? (
            <DataTable columns={columns} rows={[]} rowKey={(task) => task.id} loading />
          ) : tasks.length === 0 && diagnostics !== undefined ? (
            <PickQueueEmptyState
              diagnostics={diagnostics}
              {...(canExecute
                ? {
                    backfillAction: (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={backfillMutation.isPending}
                        onClick={() => backfillMutation.mutate()}
                      >
                        ساخت وظایف برداشت
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : (
            <DataTable columns={columns} rows={tasks} rowKey={(task) => task.id} stickyHeader />
          )}
        </Card>

        <Card>
          <CardHeader
            title="وظایف من"
            description="کارهایی که مستقیماً به شما اختصاص یافته است"
            actions={<Badge tone="info">{formatNumber(myTasks.length)} کار</Badge>}
          />
          {mineQuery.isLoading && <p className="text-sm text-slate-500">در حال دریافت…</p>}
          {mineQuery.isError && (
            <ErrorState error={mineQuery.error} onRetry={() => void mineQuery.refetch()} />
          )}
          {mineQuery.data !== undefined && myTasks.length === 0 && (
            <EmptyState
              icon={<ListChecks className="size-9" />}
              title="وظیفه‌ای به شما اختصاص نیافته است"
              description="کارهای بدون مسئول را می‌توانید از صف برداشت با دکمهٔ «شروع» به نام خود ثبت کنید."
            />
          )}
          <ul className="space-y-2">
            {myTasks.map((task) => (
              <li key={task.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <ProductThumb src={task.imageUrl} alt={task.productName ?? task.title ?? 'کالا'} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                        {task.orderNo ?? '—'} {statusBadge(task.status)}
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-700 dark:text-slate-200" dir="auto">
                        {task.productName ?? task.title ?? 'کالا'}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500" dir="ltr">
                        {task.variantSku ?? task.sku ?? '—'}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <MapPin aria-hidden className="size-3" />
                          <span dir="ltr">{task.locationCode}</span>
                        </span>
                        <span>تعداد: {formatQuantity(task.quantityRequired ?? task.quantity)}</span>
                        <span>عمر: {ageLabel(task.ageMinutes ?? 0)}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <Button
                      size="sm"
                      icon={<ScanBarcode className="size-4" />}
                      disabled={!canExecute}
                      loading={scanMutation.isPending && scanMutation.variables?.taskId === task.id}
                      onClick={() => openScan(targetFromMyTask(task))}
                    >
                      اسکن
                    </Button>
                    {task.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="outline"
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
                      disabled={!canExecute}
                      onClick={() => openComplete(targetFromMyTask(task))}
                    >
                      تکمیل
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Modal
        open={scanTarget !== null}
        onClose={() => setScanTarget(null)}
        title="اسکن بارکد کالا"
        description={
          scanTarget === null
            ? undefined
            : `سفارش ${scanTarget.orderNo ?? '—'} · ${scanTarget.variantSku ?? 'کالا'}${
                scanTarget.locationCode === null ? '' : ` · مکان ${scanTarget.locationCode}`
              }`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setScanTarget(null)}>
              انصراف
            </Button>
            <Button
              loading={scanMutation.isPending}
              icon={<ScanBarcode className="size-4" />}
              onClick={() => submitScan()}
            >
              ثبت اسکن
            </Button>
          </>
        }
      >
        {scanTarget !== null && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
              <ProductThumb src={scanTarget.imageUrl} alt={scanTarget.productName ?? 'کالا'} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" dir="auto">
                  {scanTarget.productName ?? 'کالا'}
                </p>
                <p className="text-[11px] text-slate-500" dir="ltr">
                  {scanTarget.variantSku ?? '—'}
                </p>
              </div>
              <div className="ms-auto text-end text-xs text-slate-600 dark:text-slate-300">
                <p>
                  تعداد موردنیاز:{' '}
                  <strong className="tabular">{formatQuantity(scanTarget.quantityRequired)}</strong>
                </p>
                <p className="mt-0.5 inline-flex items-center gap-1">
                  <MapPin aria-hidden className="size-3" />
                  <span dir="ltr">{scanTarget.locationCode ?? '—'}</span>
                </p>
              </div>
            </div>

            {cameraAvailable() ? (
              <CameraScanPane
                active={scanTarget !== null}
                onDetected={(value) => {
                  // A scan already in flight settles the task; ignore the camera
                  // until it finishes so one item cannot complete two tasks.
                  if (scanMutation.isPending) return;
                  setScanInput(value);
                  submitScan(value);
                }}
              />
            ) : (
              <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <Camera aria-hidden className="mt-0.5 size-4 shrink-0" />
                دوربین یا تشخیص خودکار بارکد در این دستگاه در دسترس نیست؛ بارکد را با اسکنر وارد کنید یا ۳ رقم
                آخر را بنویسید.
              </p>
            )}

            <FormField label="یا ۳ رقم آخر بارکد را وارد کنید" required>
              <Input
                dir="ltr"
                className="text-left"
                value={scanInput}
                autoFocus
                onChange={(event) => setScanInput(event.target.value)}
                placeholder="مثلاً 123"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitScan();
                  }
                }}
              />
            </FormField>
            {scanError !== null && <ErrorState message={scanError} />}
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              اسکن کامل بارکد مسیر اصلی است؛ اگر اسکنر نبود، ۳ رقم آخر بارکد کافی است. با تأیید، این قلم کامل
              برداشت‌شده ثبت و به قلم بعدی منتقل می‌شوید.
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title="تکمیل برداشت"
        description={
          target === null
            ? undefined
            : `سفارش ${target.orderNo ?? '—'} · ${target.productName ?? 'کالا'}${
                target.locationCode === null ? '' : ` · مکان ${target.locationCode}`
              }`
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
              ثبت برداشت
            </Button>
          </>
        }
      >
        {target !== null && (
          <div className="space-y-4">
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              مقدار موردنیاز: <strong className="tabular">{formatQuantity(target.quantityRequired)}</strong>
              {' · '}
              برداشت‌شده تاکنون: <strong className="tabular">{formatQuantity(target.quantityPicked)}</strong>
            </p>
            <FormField label="مقدار برداشت‌شده" required>
              <NumberInput value={quantity} onChange={setQuantity} min="0" ariaLabel="مقدار برداشت‌شده" />
            </FormField>
            <FormField
              label="بارکد کالا (اختیاری)"
              hint="در صورت اسکن، بارکد باید با کالای همین وظیفه یکسان باشد."
            >
              <Input
                dir="ltr"
                className="text-left"
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                placeholder="بارکد را اسکن یا وارد کنید"
              />
            </FormField>
            {formError !== null && <ErrorState message={formError} />}
          </div>
        )}
      </Modal>
    </>
  );
}
