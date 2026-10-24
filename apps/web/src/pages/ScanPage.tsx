import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Barcode, Minus, Plus, Search, WifiOff } from 'lucide-react';
import { ApiError, api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle, useOnlineStatus } from '../lib/hooks';
import { formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  CatalogLookupResult,
  StockAdjustResult,
  StockChannelRef,
  StockRow,
} from '../types/api';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';

interface ScanEntry {
  readonly variantId: string;
  readonly productId?: string;
  readonly productName: string;
  readonly sku: string;
  readonly onHand: string | number;
  readonly channels: readonly StockChannelRef[];
}

function channelLabel(code: string | null | undefined, fallback?: string | null): string {
  const normalized = (code ?? '').toLowerCase();
  if (normalized.includes('digikala')) return 'Digikala';
  if (normalized.includes('carexy')) return 'Carexy';
  return fallback ?? code ?? '—';
}

function channelTone(code: string | null | undefined): BadgeTone {
  const normalized = (code ?? '').toLowerCase();
  if (normalized.includes('digikala')) return 'danger';
  if (normalized.includes('carexy')) return 'info';
  return 'neutral';
}

function ChannelChips({ channels }: { readonly channels: readonly StockChannelRef[] }) {
  if (channels.length === 0) {
    return <span className="text-sm text-slate-400">به هیچ کانالی متصل نیست</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {channels.map((channel) => {
        const externalId = channel.externalVariantId ?? channel.externalId;
        return (
          <Badge
            key={`${channel.channelCode ?? ''}-${externalId ?? ''}`}
            tone={channelTone(channel.channelCode)}
            className="max-w-full"
          >
            {channelLabel(channel.channelCode, channel.channelName)}
            {externalId === undefined || externalId === null || externalId === '' ? null : (
              <span dir="ltr" className="max-w-32 truncate font-mono text-[10px] opacity-70">
                {externalId}
              </span>
            )}
          </Badge>
        );
      })}
    </div>
  );
}

/** Stock lookup by SKU (scan lookup carries no quantities). */
async function stockForVariant(variantId: string, sku: string): Promise<{
  onHand: string | number;
  channels: readonly StockChannelRef[];
}> {
  try {
    const page = await api.getPage<StockRow>('/inventory/stock', { q: sku, perPage: 25 });
    const row = page.items.find((item) => item.variantId === variantId) ?? page.items[0];
    if (row !== undefined) {
      return { onHand: row.onHand, channels: row.channels ?? [] };
    }
  } catch {
    // The product is still usable without the stock row; show zero.
  }
  return { onHand: '0', channels: [] };
}

/**
 * Resolves a scanned barcode to a variant via `GET /catalog/lookup`, then
 * enriches it with on-hand/channel data from `GET /inventory/stock?q=`.
 * When the barcode is unknown (e.g. a serial), the stock search is the
 * fallback so operators can still find the item by SKU or name.
 */
async function resolveScan(raw: string): Promise<ScanEntry> {
  const code = raw.trim();
  try {
    const lookup = await api.get<CatalogLookupResult>('/products/lookup', { barcode: code });
    const variant = lookup.variant;
    if (variant !== undefined) {
      const stock = await stockForVariant(variant.id, variant.sku);
      return {
        variantId: variant.id,
        ...(lookup.product?.id === undefined ? {} : { productId: lookup.product.id }),
        productName: lookup.product?.nameFa ?? variant.sku,
        sku: variant.sku,
        onHand: stock.onHand,
        channels: stock.channels,
      };
    }
  } catch (error) {
    // Unknown barcode (404), a too-short scan (400) or no catalog permission
    // (403) all fall back to the stock search so the scanner stays usable.
    const fallback =
      error instanceof ApiError &&
      (error.status === 400 || error.status === 403 || error.status === 404);
    if (!fallback) {
      throw error;
    }
  }

  const page = await api.getPage<StockRow>('/inventory/stock', { q: code, perPage: 25 });
  const row = page.items[0];
  if (row === undefined) {
    throw new ApiError({
      code: 'NOT_FOUND',
      status: 404,
      messageFa: 'کالایی با این بارکد یا شناسه یافت نشد.',
    });
  }
  return {
    variantId: row.variantId,
    ...(row.productId === undefined || row.productId === null ? {} : { productId: row.productId }),
    productName: row.productName,
    sku: row.sku,
    onHand: row.onHand,
    channels: row.channels ?? [],
  };
}

/** Mobile-first scanner: lookup by barcode/serial, show stock, quick +/- adjust. */
export function ScanPage() {
  useDocumentTitle('اسکن و بارکد');
  const toast = useToast();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const canAdjust = useHasPermission(PERM.inventoryAdjust);
  const [code, setCode] = useState('');
  const [submittedCode, setSubmittedCode] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const lookupQuery = useQuery({
    queryKey: queryKeys.scan.lookup(submittedCode),
    queryFn: () => resolveScan(submittedCode),
    enabled: submittedCode.length > 0,
    retry: false,
    staleTime: 20_000,
  });

  const adjustMutation = useMutation({
    mutationFn: (input: { variantId: string; quantityDelta: number }) =>
      api.post<StockAdjustResult>(
        '/inventory/stock/adjust',
        { variantId: input.variantId, quantityDelta: input.quantityDelta, reason: 'scan' },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: (result, input) => {
      const detail =
        result?.onHand === undefined || result.onHand === null
          ? undefined
          : `موجودی جدید: ${formatQuantity(result.onHand)}`;
      toast.success(
        input.quantityDelta > 0 ? 'موجودی افزایش یافت' : 'موجودی کاهش یافت',
        detail,
      );
      void queryClient.invalidateQueries({ queryKey: ['scan'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'stock'] });
    },
    onError: (error) => toast.error('تعدیل موجودی ناموفق بود', toFaErrorMessage(error)),
  });

  const submit = (): void => {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setInputError('بارکد یا سریال را وارد کنید.');
      return;
    }
    setInputError(null);
    setSubmittedCode(trimmed);
    void queryClient.invalidateQueries({ queryKey: queryKeys.scan.lookup(trimmed) });
  };

  const entry = lookupQuery.data;
  const adjusting = adjustMutation.isPending;

  return (
    <>
      <PageHeader
        title="اسکن و بارکد"
        description="بارکد یا سریال کالا را اسکن کنید تا موجودی و کانال‌ها را ببینید."
        breadcrumbs={[{ label: 'خرید' }, { label: 'اسکن و بارکد' }]}
      />

      <div className="mx-auto w-full max-w-xl space-y-4">
        {!online && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <WifiOff aria-hidden className="size-4 shrink-0" />
            اتصال شبکه قطع است؛ نتیجه اسکن پس از وصل شدن شبکه دریافت می‌شود.
          </div>
        )}

        <Card>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label
              htmlFor="scan-code"
              className="block text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              بارکد یا سریال
            </label>
            <Input
              id="scan-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="بارکد را اسکن کنید یا وارد کنید"
              autoFocus
              autoComplete="off"
              inputMode="text"
              enterKeyHint="search"
              aria-invalid={inputError !== null || undefined}
              startIcon={<Barcode aria-hidden className="size-5" />}
              className="h-14 text-lg"
            />
            {inputError !== null && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {inputError}
              </p>
            )}
            <Button
              type="submit"
              size="lg"
              block
              loading={lookupQuery.isFetching}
              icon={<Search aria-hidden className="size-5" />}
            >
              جستجو
            </Button>
          </form>
        </Card>

        {lookupQuery.isError && (
          <ErrorState
            title="کالا پیدا نشد"
            error={lookupQuery.error}
            onRetry={() => void lookupQuery.refetch()}
          />
        )}

        {entry !== undefined && (
          <Card className="space-y-4">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">کالا</p>
              <h2 className="mt-0.5 text-xl font-bold text-slate-900 dark:text-slate-100">
                {entry.productName}
              </h2>
              <p dir="ltr" className="mt-1 font-mono text-sm text-slate-500 dark:text-slate-400">
                SKU: {entry.sku}
              </p>
            </div>

            <div className="rounded-xl bg-slate-100 p-4 text-center dark:bg-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400">موجودی فعلی</p>
              <p className="mt-1 text-4xl font-bold tabular text-slate-900 dark:text-slate-100">
                {formatQuantity(entry.onHand)}
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                کانال‌های فروش
              </p>
              <ChannelChips channels={entry.channels} />
            </div>

            {canAdjust ? (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-16 text-base"
                  icon={<Minus aria-hidden className="size-5" />}
                  disabled={adjusting}
                  onClick={() =>
                    adjustMutation.mutate({ variantId: entry.variantId, quantityDelta: -1 })
                  }
                >
                  کاهش ۱
                </Button>
                <Button
                  size="lg"
                  className="h-16 text-base"
                  icon={<Plus aria-hidden className="size-5" />}
                  disabled={adjusting}
                  onClick={() =>
                    adjustMutation.mutate({ variantId: entry.variantId, quantityDelta: 1 })
                  }
                >
                  افزایش ۱
                </Button>
              </div>
            ) : (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                برای تعدیل موجودی به دسترسی <code dir="ltr">inventory.adjust</code> نیاز دارید.
              </p>
            )}
          </Card>
        )}

        {entry === undefined && !lookupQuery.isError && (
          <p className="text-center text-xs text-slate-400 dark:text-slate-500">
            پس از اسکن، نام کالا، SKU، موجودی و کانال‌های متصل نمایش داده می‌شود.
          </p>
        )}
      </div>
    </>
  );
}
