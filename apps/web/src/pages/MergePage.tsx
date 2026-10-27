/**
 * Merge workbench (`/products/merge` route wired elsewhere).
 *
 * Three tabs:
 * - «پیشنهاد هوشمند»: server-side duplicate candidates from Carexy + Digikala with
 *   the name-similarity score, multi-select and batch merge.
 * - «تاریخچه ادغام»: `erp.product_merge_log` rows with an undo action.
 * - «فایل اکسل»: export the catalog (with the best suggestion per product) and
 *   import a `sourceProductNo`/`targetProductNo` sheet.
 *
 * The API route is registered by the parent workstream; this file only exports
 * the page component.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Download, GitMerge, History, RotateCcw, Sparkles, Upload } from 'lucide-react';

import { API_BASE } from '../lib/config';
import { getAccessToken } from '../lib/auth-store';
import { api, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { Can } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FileDropzone } from '../components/ui/FileDropzone';
import { PageHeader } from '../components/ui/PageHeader';
import { Tabs, TabPanel } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

/* ------------------------------------------------------------------ types -- */

interface SuggestionPair {
  readonly aId: string;
  readonly aName: string;
  readonly aSource: string;
  readonly aProductNo: string;
  readonly bId: string;
  readonly bName: string;
  readonly bSource: string;
  readonly bProductNo: string;
  readonly similarity: number;
  readonly sameSku: boolean;
}

interface MergeWarning {
  readonly code: string;
  readonly messageFa: string;
}

interface MergeOutcome {
  readonly targetId: string;
  readonly sourceId: string;
  readonly movedVariants: number;
  readonly mergedVariants: number;
  readonly movedMappings: number;
  readonly removedMappings: number;
  readonly mergeLogId: string | null;
  readonly mergeLogRecorded: boolean;
  readonly warnings: readonly MergeWarning[];
}

interface BatchResult {
  readonly total: number;
  readonly merged: number;
  readonly failed: number;
  readonly results: readonly {
    readonly targetProductId: string;
    readonly sourceProductId: string;
    readonly ok: boolean;
    readonly result?: MergeOutcome;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }[];
}

interface MergeLogEntry {
  readonly id: string;
  readonly targetProductNo: string | null;
  readonly targetProductName: string | null;
  readonly sourceProductNo: string | null;
  readonly sourceProductName: string | null;
  readonly createdAt: string;
  readonly undoneAt: string | null;
  readonly summary: {
    readonly movedVariants: number;
    readonly retiredVariants: number;
    readonly repointedMappings: number;
    readonly retiredMappings: number;
    readonly stockWarnings: number;
  };
}

interface MergeImportResult {
  readonly total: number;
  readonly merged: number;
  readonly failed: number;
  readonly rows: readonly {
    readonly row: number;
    readonly sourceProductNo: string;
    readonly targetProductNo: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
}

const SUGGESTION_LIMIT = 100;

const SOURCE_LABELS: Record<string, string> = {
  carexy: 'کریکسی',
  digikala: 'دیجی‌کالا',
  manual: 'دستی',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function sourceTone(source: string): 'brand' | 'info' | 'neutral' {
  if (source === 'carexy') return 'brand';
  if (source === 'digikala') return 'info';
  return 'neutral';
}

function pairKey(pair: SuggestionPair): string {
  return `${pair.aId}:${pair.bId}`;
}

/**
 * Which side survives. Carexy is the own shop, so a Carexy listing always wins
 * over a marketplace copy; otherwise the first column is the target.
 */
function orient(pair: SuggestionPair): {
  readonly targetProductId: string;
  readonly sourceProductId: string;
  readonly targetName: string;
  readonly sourceName: string;
} {
  if (pair.bSource === 'carexy' && pair.aSource !== 'carexy') {
    return {
      targetProductId: pair.bId,
      sourceProductId: pair.aId,
      targetName: pair.bName,
      sourceName: pair.aName,
    };
  }
  return {
    targetProductId: pair.aId,
    sourceProductId: pair.bId,
    targetName: pair.aName,
    sourceName: pair.bName,
  };
}

function similarityPercent(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.round(clamped * 100);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('file_read_failed'));
    };
    reader.readAsDataURL(file);
  });
}

/** Downloads the workbook with the bearer token (a plain link cannot send it). */
async function downloadMergeWorkbook(): Promise<void> {
  const token = getAccessToken();
  const response = await fetch(`${API_BASE}/products/merge/export.xlsx`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(response.status === 403 ? 'forbidden' : 'export_failed');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'product-merge.xlsx';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------- page -- */

export function MergePage() {
  useDocumentTitle('ادغام محصولات');
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState('suggestions');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [undoId, setUndoId] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<MergeImportResult | null>(null);

  const suggestions = useQuery({
    queryKey: ['products', 'merge-suggestions', { limit: SUGGESTION_LIMIT }],
    queryFn: () => api.getPage<SuggestionPair>('/products/merge/suggestions', { limit: SUGGESTION_LIMIT }),
  });

  const merges = useQuery({
    queryKey: ['products', 'merges', { limit: 100 }],
    queryFn: () => api.get<MergeLogEntry[]>('/products/merges', { limit: 100 }),
    enabled: tab === 'history',
  });

  const pairs = suggestions.data?.items ?? [];

  const pairByKey = useMemo(() => {
    const map = new Map<string, SuggestionPair>();
    for (const pair of pairs) map.set(pairKey(pair), pair);
    return map;
  }, [pairs]);

  const chosenPairs = useMemo(
    () =>
      [...selected]
        .map((key) => pairByKey.get(key))
        .filter((pair): pair is SuggestionPair => pair !== undefined),
    [selected, pairByKey],
  );

  const togglePair = useCallback((key: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback((): void => {
    setSelected(new Set());
  }, []);

  const batch = useMutation({
    mutationFn: (input: readonly SuggestionPair[]) =>
      api.post<BatchResult>('/products/merge/batch', {
        pairs: input.map((pair) => {
          const direction = orient(pair);
          return {
            targetProductId: direction.targetProductId,
            sourceProductId: direction.sourceProductId,
          };
        }),
      }),
    onSuccess: (result) => {
      if (result.failed === 0) {
        toast.success(
          'ادغام انجام شد',
          `${result.merged} جفت ادغام شد و موجودی/قیمت برای کانال‌های متصل به صف رفت.`,
        );
      } else {
        toast.error(
          'ادغام با خطا مواجه شد',
          `${result.merged} جفت ادغام شد و ${result.failed} جفت ناموفق بود.`,
        );
      }
      clearSelection();
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => toast.error('ادغام انتخاب‌شده‌ها ناموفق بود', toFaErrorMessage(error)),
  });

  const undo = useMutation({
    mutationFn: (id: string) => api.post<{ restoredVariants: number }>(`/products/merges/${id}/undo`),
    onSuccess: () => {
      toast.success('ادغام بازگردانی شد', 'محصول مبدأ و تنوع‌های آن به حالت قبل برگشتند.');
      setUndoId(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => toast.error('بازگردانی ادغام ناموفق بود', toFaErrorMessage(error)),
  });

  const exportWorkbook = useMutation({
    mutationFn: downloadMergeWorkbook,
    onSuccess: () => toast.success('فایل اکسل آماده شد', 'بارگیری فایل آغاز شد.'),
    onError: () => toast.error('تهیه فایل اکسل ناموفق بود', 'دوباره تلاش کنید.'),
  });

  const importWorkbook = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await readFileAsDataUrl(file);
      return api.post<MergeImportResult>('/products/merge/import.xlsx', { file: base64 });
    },
    onSuccess: (result) => {
      setImportResult(result);
      if (result.failed === 0) {
        toast.success('ادغام گروهی انجام شد', `${result.merged} ردیف از فایل ادغام شد.`);
      } else {
        toast.error(
          'برخی ردیف‌ها ادغام نشدند',
          `${result.merged} ردیف موفق و ${result.failed} ردیف ناموفق بود.`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => toast.error('بارگذاری فایل اکسل ناموفق بود', toFaErrorMessage(error)),
  });

  /* --------------------------------------------------------- suggestions -- */

  const suggestionColumns: readonly Column<SuggestionPair>[] = [
    {
      key: 'select',
      header: 'انتخاب',
      width: '1%',
      render: (pair) => (
        <Checkbox
          checked={selected.has(pairKey(pair))}
          onChange={() => togglePair(pairKey(pair))}
          aria-label={`انتخاب جفت ${pair.aName} و ${pair.bName}`}
        />
      ),
    },
    {
      key: 'pair',
      header: 'جفت مشکوک به تکرار',
      render: (pair) => {
        const direction = orient(pair);
        return (
          <div className="flex flex-col gap-1 text-sm">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone="success">مقصد</Badge>
              <span className="font-medium text-slate-900 dark:text-slate-100">{direction.targetName}</span>
              <span className="text-xs text-slate-400" dir="ltr">
                {pair.aSource === 'carexy' ? pair.aProductNo : pair.bProductNo}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <Badge tone="warning">مبدأ</Badge>
              <span>{direction.sourceName}</span>
              <span className="text-xs text-slate-400" dir="ltr">
                {pair.aSource === 'carexy' ? pair.bProductNo : pair.aProductNo}
              </span>
            </span>
          </div>
        );
      },
    },
    {
      key: 'sources',
      header: 'منبع',
      render: (pair) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={sourceTone(pair.aSource)}>{sourceLabel(pair.aSource)}</Badge>
          <span aria-hidden className="text-slate-400">
            ↔
          </span>
          <Badge tone={sourceTone(pair.bSource)}>{sourceLabel(pair.bSource)}</Badge>
        </span>
      ),
    },
    {
      key: 'similarity',
      header: 'شباهت نام',
      width: '180px',
      render: (pair) => {
        const percent = similarityPercent(pair.similarity);
        return (
          <div className="flex items-center gap-2">
            <div
              className="h-2 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
              role="img"
              aria-label={`شباهت نام ${percent} درصد`}
            >
              <div
                className={clsx(
                  'h-full rounded-full',
                  percent >= 80 ? 'bg-emerald-500' : percent >= 65 ? 'bg-amber-500' : 'bg-slate-400',
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="tabular text-xs text-slate-600 dark:text-slate-300">{percent}٪</span>
          </div>
        );
      },
    },
    {
      key: 'sameSku',
      header: 'SKU مشترک',
      align: 'center',
      width: '90px',
      render: (pair) =>
        pair.sameSku ? <Badge tone="warning">بله</Badge> : <span className="text-xs text-slate-400">—</span>,
    },
  ];

  const allSelected = pairs.length > 0 && pairs.every((pair) => selected.has(pairKey(pair)));
  const similarityMethod = (suggestions.data?.meta as { similarityMethod?: string } | undefined)
    ?.similarityMethod;

  /* -------------------------------------------------------------- history -- */

  const historyColumns: readonly Column<MergeLogEntry>[] = [
    {
      key: 'target',
      header: 'محصول مقصد (بازمانده)',
      render: (entry) => (
        <div className="flex flex-col">
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {entry.targetProductName ?? '—'}
          </span>
          <span className="text-xs text-slate-400" dir="ltr">
            {entry.targetProductNo ?? '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'source',
      header: 'محصول مبدأ (بایگانی‌شده)',
      render: (entry) => (
        <div className="flex flex-col">
          <span>{entry.sourceProductName ?? '—'}</span>
          <span className="text-xs text-slate-400" dir="ltr">
            {entry.sourceProductNo ?? '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'summary',
      header: 'جزئیات',
      render: (entry) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {entry.summary.movedVariants} تنوع منتقل، {entry.summary.retiredVariants} تنوع تکراری،{' '}
          {entry.summary.repointedMappings} اتصال بازنشانی
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'تاریخ ادغام',
      render: (entry) => formatJalaliDateTime(entry.createdAt),
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (entry) =>
        entry.undoneAt === null ? (
          <Badge tone="success">ادغام‌شده</Badge>
        ) : (
          <Badge tone="neutral">بازگردانی‌شده</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      width: '1%',
      render: (entry) => (
        <Can permission={PERM.productUpdate}>
          <Button
            size="sm"
            variant="outline"
            icon={<RotateCcw className="size-3.5" />}
            disabled={entry.undoneAt !== null || undo.isPending}
            onClick={() => setUndoId(entry.id)}
          >
            بازگردانی
          </Button>
        </Can>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="ادغام محصولات"
        description="پیشنهاد خودکار کالاهای تکراری از کریکسی و دیجی‌کالا، ادغام گروهی، تاریخچه قابل بازگردانی و تبادل فایل اکسل"
      />

      <Tabs
        ariaLabel="بخش‌های ادغام محصولات"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'suggestions', label: 'پیشنهاد هوشمند', icon: <Sparkles className="size-4" /> },
          { value: 'history', label: 'تاریخچه ادغام', icon: <History className="size-4" /> },
          { value: 'excel', label: 'فایل اکسل', icon: <Upload className="size-4" /> },
        ]}
        className="mt-4"
      />

      {tab === 'suggestions' && (
        <TabPanel value="suggestions">
          <Card>
            <CardHeader
              title="جفت‌های مشکوک به تکرار"
              description={
                similarityMethod === undefined
                  ? 'شباهت نام روی محصولات فعال محاسبه می‌شود (حداقل ۵۵٪).'
                  : `شباهت نام با روش ${similarityMethod === 'pg_trgm' ? 'pg_trgm' : 'bigram نرمال‌شده'} محاسبه شده است.`
              }
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    label="انتخاب همه"
                    checked={allSelected}
                    disabled={pairs.length === 0}
                    onChange={() => {
                      if (allSelected) clearSelection();
                      else setSelected(new Set(pairs.map((pair) => pairKey(pair))));
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void suggestions.refetch()}
                    loading={suggestions.isFetching}
                  >
                    بازخوانی
                  </Button>
                  <Can permission={PERM.productUpdate}>
                    <Button
                      icon={<GitMerge className="size-4" />}
                      disabled={chosenPairs.length === 0 || batch.isPending}
                      loading={batch.isPending}
                      onClick={() => batch.mutate(chosenPairs)}
                    >
                      ادغام انتخاب‌شده‌ها
                      {chosenPairs.length > 0 && (
                        <span className="ms-1 rounded-full bg-white/20 px-1.5 text-xs">
                          {chosenPairs.length}
                        </span>
                      )}
                    </Button>
                  </Can>
                </div>
              }
            />
            <CardContent>
              <DataTable
                columns={suggestionColumns}
                rows={pairs}
                rowKey={pairKey}
                loading={suggestions.isLoading}
                error={suggestions.isError ? suggestions.error : undefined}
                onRetry={() => void suggestions.refetch()}
                caption="پیشنهادهای ادغام محصول"
                emptyTitle="جفت مشکوکی پیدا نشد"
                emptyDescription="وقتی کالای تکراری از کانال‌ها وارد شود، اینجا با درصد شباهت نمایش داده می‌شود."
              />
            </CardContent>
          </Card>
        </TabPanel>
      )}

      {tab === 'history' && (
        <TabPanel value="history">
          <Card>
            <CardHeader
              title="تاریخچه ادغام"
              description="هر ادغام با نسخه‌ای از تغییرات ذخیره می‌شود و تا زمانی که بازگردانی نشده قابل بازگشت است."
              actions={
                <Button variant="outline" onClick={() => void merges.refetch()} loading={merges.isFetching}>
                  بازخوانی
                </Button>
              }
            />
            <CardContent>
              <DataTable
                columns={historyColumns}
                rows={merges.data ?? []}
                rowKey={(entry) => entry.id}
                loading={merges.isLoading}
                error={merges.isError ? merges.error : undefined}
                onRetry={() => void merges.refetch()}
                caption="تاریخچه ادغام محصولات"
                emptyTitle="تاریخچه‌ای وجود ندارد"
                emptyDescription="پس از اولین ادغام، سطر آن با امکان بازگردانی اینجا ظاهر می‌شود."
              />
            </CardContent>
          </Card>
        </TabPanel>
      )}

      {tab === 'excel' && (
        <TabPanel value="excel">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="بارگیری فایل اکسل"
                description="فهرست محصولات فعال با شناسه، نام، SKU، منبع کانال، قیمت، موجودی و بهترین پیشنهاد شباهت."
              />
              <CardContent>
                <Button
                  icon={<Download className="size-4" />}
                  loading={exportWorkbook.isPending}
                  onClick={() => exportWorkbook.mutate()}
                >
                  بارگیری فایل اکسل
                </Button>
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  ستون‌ها: productNo، name، sku، source، price، stock، suggestions
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title="بارگذاری فایل ادغام"
                description="فایلی با ستون‌های sourceProductNo و targetProductNo؛ هر ردیف مستقل ادغام می‌شود."
              />
              <CardContent>
                <Can
                  permission={PERM.productUpdate}
                  fallback={
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      برای بارگذاری فایل، دسترسی ویرایش محصول لازم است.
                    </p>
                  }
                >
                  <FileDropzone
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    maxSizeMB={1.5}
                    multiple={false}
                    uploading={importWorkbook.isPending}
                    label="انتخاب فایل اکسل"
                    hint="فایل xlsx تا ۱٫۵ مگابایت؛ سطر اول باید سرستون داشته باشد."
                    files={
                      importFile === null
                        ? []
                        : [{ id: 'import', name: importFile.name, sizeBytes: importFile.size }]
                    }
                    onRemove={() => {
                      setImportFile(null);
                      setImportResult(null);
                    }}
                    onFiles={(files) => {
                      const file = files[0];
                      if (file === undefined) return;
                      setImportFile(file);
                      setImportResult(null);
                    }}
                  />
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      icon={<Upload className="size-4" />}
                      disabled={importFile === null || importWorkbook.isPending}
                      loading={importWorkbook.isPending}
                      onClick={() => {
                        if (importFile !== null) importWorkbook.mutate(importFile);
                      }}
                    >
                      ادغام بر اساس فایل
                    </Button>
                  </div>
                </Can>
              </CardContent>
            </Card>
          </div>

          {importResult !== null && (
            <Card className="mt-4">
              <CardHeader
                title="نتیجه بارگذاری"
                description={`${importResult.merged} ردیف ادغام شد و ${importResult.failed} ردیف ناموفق بود.`}
              />
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {importResult.rows.map((row) => (
                    <li
                      key={`${row.row}-${row.sourceProductNo}-${row.targetProductNo}`}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-slate-700"
                    >
                      <span className="text-xs text-slate-400">سطر {row.row}</span>
                      <span dir="ltr" className="font-medium">
                        {row.sourceProductNo} → {row.targetProductNo}
                      </span>
                      {row.ok ? (
                        <Badge tone="success">ادغام شد</Badge>
                      ) : (
                        <Badge tone="danger">{row.error ?? 'ناموفق'}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabPanel>
      )}

      <ConfirmDialog
        open={undoId !== null}
        title="بازگردانی ادغام"
        description="محصول مبدأ از بایگانی خارج می‌شود، تنوع‌ها و اتصال‌های کانال به حالت قبل برمی‌گردند. اگر اتصالی در این فاصله روی مقصد ساخته شده باشد، همان مورد بازگردانی نمی‌شود."
        confirmLabel="بازگردانی"
        tone="danger"
        loading={undo.isPending}
        onCancel={() => setUndoId(null)}
        onConfirm={() => {
          if (undoId !== null) undo.mutate(undoId);
        }}
      />
    </>
  );
}
