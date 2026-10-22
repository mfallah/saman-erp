import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Save } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { formatQuantity, toLatinDigits } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { StockAdjustInput, StockAdjustResult, StockChannelRef, StockRow } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

const PER_PAGE = 20;

/** Familiar partner name; the API may return Persian names for new channels. */
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

function queuedChannelLabel(channel: string | StockChannelRef): string {
  if (typeof channel === 'string') return channelLabel(channel, channel);
  return channelLabel(channel.channelCode, channel.channelName ?? channel.channelCode);
}

/** Accepts signed decimals and Persian/Arabic-Indic digits while typing. */
function normalizeDeltaInput(raw: string): string | null {
  const normalized = toLatinDigits(raw)
    .replace(/[\s,\u066c\u200c]/g, '')
    .replace(/\u2212/g, '-');
  return /^-?\d*(?:\.\d*)?$/.test(normalized) ? normalized : null;
}

/** Returns the numeric delta, or null for empty/zero/invalid input. */
function parseDelta(raw: string): number | null {
  void 0;
  const normalized = normalizeDeltaInput(raw);
  if (normalized !== null && !/^-?\d+$/.test(normalized)) return null;
  if (normalized === null || normalized === '' || normalized === '-' || normalized.endsWith('.')) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function ChannelChips({ channels }: { readonly channels?: readonly StockChannelRef[] }) {
  if (channels === undefined || channels.length === 0) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {channels.map((channel) => {
        const externalId = channel.externalVariantId ?? channel.externalId;
        return (
          <Badge
            key={`${channel.channelCode ?? ''}-${externalId ?? ''}`}
            tone={channelTone(channel.channelCode)}
            className="max-w-52"
          >
            {channelLabel(channel.channelCode, channel.channelName)}
            {externalId === undefined || externalId === null || externalId === '' ? null : (
              <span dir="ltr" className="max-w-28 truncate font-mono text-[10px] opacity-70">
                {externalId}
              </span>
            )}
          </Badge>
        );
      })}
    </div>
  );
}

/** Channel stock: per-variant on-hand plus channel listings and inline adjustment. */
export function InventoryStockPage() {
  useDocumentTitle('موجودی کانال‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.inventoryRead);
  const canAdjust = useHasPermission(PERM.inventoryAdjust);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const debouncedSearch = useDebouncedValue(search, 350);

  const stockQuery = useQuery({
    queryKey: queryKeys.inventory.stock({ q: debouncedSearch, page }),
    queryFn: () =>
      api.getPage<StockRow>('/inventory/stock', {
        page,
        perPage: PER_PAGE,
        ...(debouncedSearch.trim().length >= 2 ? { q: debouncedSearch.trim() } : {}),
      }),
    enabled: canRead,
  });

  const adjustMutation = useMutation({
    mutationFn: (input: StockAdjustInput) =>
      api.post<StockAdjustResult>('/inventory/stock/adjust', input, { idempotencyKey: newRequestId() }),
    onSuccess: (result, input) => {
      const queued = (result?.queuedChannels ?? []).map(queuedChannelLabel);
      const uniqueQueued = [...new Set(queued)];
      toast.success(
        'موجودی کانال‌ها به‌روزرسانی شد',
        uniqueQueued.length > 0
          ? `این تغییر در صف ارسال به ${uniqueQueued.join('، ')} قرار گرفت.`
          : 'تغییر موجودی ثبت شد و کانالی در صف ارسال قرار نگرفت.',
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[input.variantId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'stock'] });
    },
    onError: (error) => toast.error('ثبت موجودی ناموفق بود', toFaErrorMessage(error)),
  });

  const columns: readonly Column<StockRow>[] = [
    {
      key: 'product',
      header: 'نام محصول',
      render: (row) =>
        row.productId === undefined || row.productId === null ? (
          row.productName
        ) : (
          <Link
            to="/products/$id"
            params={{ id: row.productId }}
            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            {row.productName}
          </Link>
        ),
    },
    {
      key: 'sku',
      header: 'SKU',
      render: (row) => <span dir="ltr">{row.sku}</span>,
    },
    {
      key: 'onHand',
      header: 'موجودی',
      align: 'end',
      render: (row) => <span className="tabular">{formatQuantity(row.onHand)}</span>,
    },
    {
      key: 'channels',
      header: 'کانال‌ها',
      render: (row) => <ChannelChips channels={row.channels} />,
    },
    {
      key: 'adjust',
      header: 'موجودی جدید/تعدیل',
      render: (row) => {
        const draft = drafts[row.variantId] ?? '';
        const delta = parseDelta(draft);
        const saving =
          adjustMutation.isPending && adjustMutation.variables?.variantId === row.variantId;
        return (
          <div className="flex items-center gap-2">
            <Input
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={draft}
              placeholder="±"
              aria-label={`موجودی جدید یا تعدیل برای ${row.sku}`}
              invalid={draft.trim().length > 0 && delta === null}
              className="h-9 w-28 text-left tabular"
              onChange={(event) => {
                const normalized = normalizeDeltaInput(event.target.value);
                if (normalized === null) return;
                setDrafts((current) => ({ ...current, [row.variantId]: normalized }));
              }}
            />
            <Button
              size="sm"
              variant="outline"
              icon={<Save className="size-3.5" />}
              loading={saving}
              disabled={delta === null}
              onClick={() => {
                if (delta === null) return;
                adjustMutation.mutate({ variantId: row.variantId, quantityDelta: delta, reason: 'ui' });
              }}
            >
              ذخیره
            </Button>
          </div>
        );
      },
    },
  ];

  if (!canRead) {
    return (
      <>
        <PageHeader title="موجودی کانال‌ها" />
        <PermissionNotice permission={PERM.inventoryRead} />
      </>
    );
  }

  const rows = stockQuery.data?.items ?? [];
  const pagination = stockQuery.data?.pagination;

  return (
    <>
      <PageHeader
        title="موجودی کانال‌ها"
        description="موجودی هر تنوع کالا و شناسه‌های متناظر آن در کانال‌های فروش"
        breadcrumbs={[{ label: 'انبار', to: '/inventory' }, { label: 'موجودی کانال‌ها' }]}
      />

      <Card>
        <CardHeader
          title="موجودی و شناسه کانال‌ها"
          description="برای تعدیل، مقدار مثبت (افزایش) یا منفی (کاهش) را وارد و ذخیره کنید. تغییر پس از ثبت برای کانال‌های متصل در صف ارسال قرار می‌گیرد."
        />

        <DataTableToolbar
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="جستجوی نام محصول یا SKU…"
          onRefresh={() => void stockQuery.refetch()}
          refreshing={stockQuery.isFetching}
        />

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.variantId}
          loading={stockQuery.isLoading}
          error={stockQuery.isError ? stockQuery.error : undefined}
          onRetry={() => void stockQuery.refetch()}
          caption="موجودی کانال‌ها"
          emptyTitle="تنوعی یافت نشد"
          emptyDescription="با تغییر جستجو دوباره امتحان کنید یا از صفحه محصولات، تنوع جدید بسازید."
        />

        {stockQuery.data !== undefined && (
          <Pagination
            mode="offset"
            page={page}
            perPage={PER_PAGE}
            {...(pagination?.total === undefined ? {} : { total: pagination.total })}
            {...(pagination?.totalPages === undefined ? {} : { totalPages: pagination.totalPages })}
            onPageChange={setPage}
            disabled={stockQuery.isFetching}
          />
        )}
      </Card>
    </>
  );
}
