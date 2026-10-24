import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackagePlus } from 'lucide-react';
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
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
  { value: 'archived', label: 'بایگانی' },
];

const columns: readonly Column<ProductSummary>[] = [
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
  const canCreate = useHasPermission(PERM.productCreate);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);

  const query = useQuery({
    queryKey: queryKeys.catalog.products({ q: debouncedSearch, status, page }),
    queryFn: () =>
      api.getPage<ProductSummary>('/products', {
        page,
        perPage: 20,
        ...(debouncedSearch.length >= 2 ? { q: debouncedSearch } : {}),
        ...(status === '' ? {} : { status }),
      ...(stockFilter === '' ? {} : { hasStock: stockFilter === 'in' }),
      }),
  });

  const items = query.data?.items ?? [];
  const pagination = query.data?.pagination;

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
        columns={columns}
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
    </>
  );
}
