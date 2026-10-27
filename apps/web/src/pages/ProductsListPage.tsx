import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GitMerge, PackagePlus } from 'lucide-react';
import { api, toFaErrorMessage } from '../lib/api-client';
import { formatJalali } from '../lib/dates';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { ProductSummary } from '../types/api';
import { Can } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
  { value: 'archived', label: 'بایگانی' },
];

const MERGE_CONFIRM_WORD = 'ادغام';

/** Row of `GET /products/merge/candidates` (manual duplicate picker). */
interface MergeCandidate {
  readonly id: string;
  readonly productNo: string;
  readonly nameFa: string;
  readonly nameEn: string | null;
  readonly status: string;
  readonly categoryName: string | null;
  readonly sku: string | null;
  readonly variantCount: number;
}

/** Result of `POST /products/:id/merge`. */
interface MergeResult {
  readonly targetId: string;
  readonly movedVariants: number;
  readonly mergedVariants: number;
  readonly movedMappings: number;
  readonly removedMappings: number;
  readonly archivedSourceId: string;
}

/**
 * Product list rows may expose the imported source image under either the
 * camelCase field returned by the API mapper or the raw DB column name.
 */
interface ProductListRow extends ProductSummary {
  readonly imageUrl?: string | null;
  readonly image_url?: string | null;
}

function productImageUrl(product: ProductListRow): string | null {
  const value = product.imageUrl ?? product.image_url;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 48px hotlinked thumbnail with a first-letter fallback for missing/broken images. */
function ProductThumb({ product }: { readonly product: ProductListRow }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = productImageUrl(product);
  if (url === null || failedUrl === url) {
    return (
      <span
        aria-hidden
        className="grid size-12 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-100 text-base font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
      >
        {Array.from(product.nameFa.trim())[0] ?? '؟'}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={product.nameFa}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
      className="size-12 shrink-0 rounded-lg border border-slate-200 object-cover dark:border-slate-700"
    />
  );
}

const columns: readonly Column<ProductListRow>[] = [
  {
    key: 'image',
    header: 'تصویر',
    width: '1%',
    render: (product) => <ProductThumb product={product} />,
  },
  {
    key: 'nameFa',
    header: 'نام کالا',
    sortable: true,
    render: (product) => (
      <Link
        to="/products/$id"
        params={{ id: product.id }}
        className="font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        {product.nameFa}
      </Link>
    ),
  },
  {
    key: 'sku',
    header: 'شناسه (SKU)',
    render: (product) => <span dir="ltr">{product.sku ?? '—'}</span>,
  },
  { key: 'category', header: 'دسته‌بندی', render: (product) => product.category?.nameFa ?? product.category?.name ?? '—' },
  { key: 'status', header: 'وضعیت', render: (product) => <StatusBadge status={product.status} /> },
  {
    key: 'stock',
    header: 'موجودی',
    render: (product) =>
      product.onHand !== undefined ? (
        <div className="flex items-center gap-2">
          <span className="tabular">{formatQuantity(product.onHand)}</span>
          <Badge tone={Number(product.onHand) > 0 ? 'success' : 'neutral'}>
            {Number(product.onHand) > 0 ? 'موجود' : 'ناموجود'}
          </Badge>
        </div>
      ) : product.hasStock === true ? (
        <Badge tone="success">موجود</Badge>
      ) : (
        '—'
      ),
  },
  {
    key: 'updatedAt',
    header: 'آخرین تغییر',
    render: (product) =>
      product.updatedAt === undefined ? '—' : formatJalali(product.updatedAt),
  },
];

/** Product catalog list (search, status filter, offset pagination). */
export function ProductsListPage() {
  useDocumentTitle('محصولات');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canCreate = useHasPermission(PERM.productCreate);
  const canMerge = useHasPermission(PERM.productUpdate);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);

  const [mergeTarget, setMergeTarget] = useState<ProductSummary | null>(null);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeSource, setMergeSource] = useState<MergeCandidate | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState('');
  const debouncedMergeSearch = useDebouncedValue(mergeSearch, 350);

  const query = useQuery({
    queryKey: queryKeys.catalog.products({ q: debouncedSearch, status, page }),
    queryFn: () =>
      api.getPage<ProductListRow>('/products', {
        page,
        perPage: 20,
        ...(debouncedSearch.length >= 2 ? { q: debouncedSearch } : {}),
        ...(status === '' ? {} : { status }),
      ...(stockFilter === '' ? {} : { hasStock: stockFilter === 'in' }),
      }),
  });

  const candidates = useQuery({
    queryKey: [
      'products',
      'merge-candidates',
      { q: debouncedMergeSearch, excludeId: mergeTarget?.id ?? null },
    ],
    queryFn: () =>
      api.get<MergeCandidate[]>('/products/merge/candidates', {
        q: debouncedMergeSearch,
        ...(mergeTarget === null ? {} : { excludeId: mergeTarget.id }),
      }),
    enabled: mergeTarget !== null && debouncedMergeSearch.trim().length >= 2,
  });

  const closeMerge = (): void => {
    setMergeTarget(null);
    setMergeSearch('');
    setMergeSource(null);
    setMergeConfirm('');
  };

  const openMerge = (product: ProductSummary): void => {
    setMergeTarget(product);
    setMergeSearch('');
    setMergeSource(null);
    setMergeConfirm('');
  };

  const merge = useMutation({
    mutationFn: (input: { targetId: string; sourceProductId: string }) =>
      api.post<MergeResult>(`/products/${input.targetId}/merge`, {
        sourceProductId: input.sourceProductId,
      }),
    onSuccess: (result) => {
      toast.success(
        'ادغام کالا انجام شد',
        `${result.movedVariants + result.mergedVariants} تنوع و ${result.movedMappings} اتصال کانال به کالای مقصد منتقل شد.`,
      );
      closeMerge();
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => toast.error('ادغام کالا ناموفق بود', toFaErrorMessage(error)),
  });

  const items = query.data?.items ?? [];
  const pagination = query.data?.pagination;
  const mergeReady =
    mergeTarget !== null &&
    mergeSource !== null &&
    mergeConfirm.trim() === MERGE_CONFIRM_WORD &&
    !merge.isPending;

  const mergeColumn: Column<ProductListRow> = {
    key: 'merge',
    header: '',
    align: 'end',
    width: '1%',
    render: (product) => (
      <Button
        size="sm"
        variant="outline"
        icon={<GitMerge className="size-3.5" />}
        onClick={() => openMerge(product)}
      >
        ادغام
      </Button>
    ),
  };

  const tableColumns = canMerge ? [...columns, mergeColumn] : columns;

  return (
    <>
      <PageHeader
        title="محصولات"
        description="کاتالوگ کالاها، شناسه‌ها و وضعیت انتشار"
        actions={
          <Can permission={PERM.productCreate}>
            <Link to="/products/new">
              <Button icon={<PackagePlus className="size-4" />}>کالای جدید</Button>
            </Link>
          </Can>
        }
      />

      <DataTableToolbar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="جستجوی نام یا شناسه کالا…"
        filters={
          <div className="flex gap-2">
          <Select
            aria-label="فیلتر موجودی"
            options={[
              { value: '', label: 'همه موجودی‌ها' },
              { value: 'in', label: 'موجود' },
              { value: 'out', label: 'ناموجود' },
            ]}
            value={stockFilter}
            onChange={(event) => {
              setStockFilter(event.target.value);
              setPage(1);
            }}
          />
          <Select
            aria-label="فیلتر وضعیت"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="w-40"
          />
          </div>
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />

      <DataTable
        columns={tableColumns}
        rows={items}
        rowKey={(product) => product.id}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        caption="فهرست محصولات"
        emptyTitle="کالایی یافت نشد"
        emptyDescription="با تغییر جستجو یا فیلتر وضعیت دوباره امتحان کنید."
        emptyAction={
          canCreate ? (
            <Link to="/products/new">
              <Button size="sm">افزودن اولین کالا</Button>
            </Link>
          ) : undefined
        }
      />

      {query.isError && query.error !== null && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {toFaErrorMessage(query.error)}
        </p>
      )}

      {query.data !== undefined && (
        <Pagination
          mode="offset"
          page={page}
          perPage={20}
          {...(pagination?.total === undefined ? {} : { total: pagination.total })}
          {...(pagination?.totalPages === undefined ? {} : { totalPages: pagination.totalPages })}
          onPageChange={setPage}
          disabled={query.isFetching}
        />
      )}

      <Modal
        open={mergeTarget !== null}
        onClose={closeMerge}
        title="ادغام کالای تکراری"
        description="کالای تکراری (مبدأ) در کالای جاری (مقصد) ادغام و سپس بایگانی می‌شود."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={closeMerge} disabled={merge.isPending}>
              انصراف
            </Button>
            <Button
              variant="danger"
              icon={<GitMerge className="size-4" />}
              loading={merge.isPending}
              disabled={!mergeReady}
              onClick={() => {
                if (mergeTarget === null || mergeSource === null) return;
                merge.mutate({ targetId: mergeTarget.id, sourceProductId: mergeSource.id });
              }}
            >
              ادغام کالا
            </Button>
          </>
        }
      >
        {mergeTarget !== null && (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
              <p className="font-medium text-slate-900 dark:text-slate-100">{mergeTarget.nameFa}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                کالای مقصد — شناسه: <span dir="ltr">{mergeTarget.sku ?? mergeTarget.id}</span>
              </p>
            </div>

            <FormField
              label="جستجوی کالای تکراری (نام یا SKU)"
              hint="حداقل دو حرف؛ کالای جاری از فهرست حذف می‌شود."
            >
              <Input
                value={mergeSearch}
                onChange={(event) => {
                  setMergeSearch(event.target.value);
                  setMergeSource(null);
                }}
                placeholder="نام یا شناسه کالای تکراری…"
                maxLength={100}
                autoFocus
              />
            </FormField>

            {debouncedMergeSearch.trim().length < 2 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                برای دیدن پیشنهادها حداقل دو حرف تایپ کنید.
              </p>
            ) : candidates.isLoading ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">در حال جستجو…</p>
            ) : candidates.isError ? (
              <p role="alert" className="text-xs text-red-600">
                {toFaErrorMessage(candidates.error)}
              </p>
            ) : (candidates.data ?? []).length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">کالایی یافت نشد.</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto" aria-label="کالاهای پیشنهادی">
                {(candidates.data ?? []).map((candidate) => {
                  const selected = mergeSource?.id === candidate.id;
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        onClick={() => setMergeSource(candidate)}
                        aria-pressed={selected}
                        className={
                          selected
                            ? 'w-full rounded-lg border border-brand-500 bg-brand-50 p-2 text-start text-sm dark:bg-brand-950'
                            : 'w-full rounded-lg border border-slate-200 p-2 text-start text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
                        }
                      >
                        <span className="block font-medium text-slate-900 dark:text-slate-100">
                          {candidate.nameFa}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                          <span dir="ltr">{candidate.sku ?? candidate.productNo}</span>
                          {candidate.categoryName === null ? '' : ` — ${candidate.categoryName}`}
                          {` — ${candidate.variantCount} تنوع`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {mergeSource !== null && (
              <p className="text-xs text-slate-600 dark:text-slate-300">
                کالای مبدأ انتخاب شد: <strong>{mergeSource.nameFa}</strong>
              </p>
            )}

            <FormField
              label="تأیید"
              hint={`برای فعال شدن دکمهٔ ادغام، عبارت «${MERGE_CONFIRM_WORD}» را تایپ کنید.`}
            >
              <Input
                value={mergeConfirm}
                onChange={(event) => setMergeConfirm(event.target.value)}
                placeholder={MERGE_CONFIRM_WORD}
                dir="rtl"
              />
            </FormField>

            <p className="text-xs text-amber-700 dark:text-amber-400">
              موجودی و اسناد انبار کالای مبدأ جابه‌جا نمی‌شوند. تنوع‌های با SKU یکسان ادغام و
              اتصال‌های کانال به تنوع مقصد منتقل می‌شوند؛ کالای مبدأ بایگانی می‌شود.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
