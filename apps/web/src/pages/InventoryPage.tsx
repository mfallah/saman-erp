import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPlus, Plus, Trash2 } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime, lastNDaysISO, type DateRangeISO } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber, formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { BalanceRow, LedgerRow, VariantSummary, Warehouse } from '../types/api';
import { Can, PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Combobox } from '../components/ui/Combobox';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { IconButton } from '../components/ui/IconButton';
import { Modal } from '../components/ui/Modal';
import { NumberInput } from '../components/ui/NumberInput';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { TabPanel, Tabs } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

const balanceColumns: readonly Column<BalanceRow>[] = [
  {
    key: 'product',
    header: 'کالا',
    render: (row) => row.product?.nameFa ?? row.product?.name ?? row.variant?.name ?? '—',
  },
  { key: 'sku', header: 'شناسه', render: (row) => <span dir="ltr">{row.variant?.code ?? row.variant?.id?.slice(0, 8) ?? '—'}</span> },
  { key: 'warehouse', header: 'انبار', render: (row) => row.warehouse?.name ?? '—' },
  { key: 'location', header: 'موقعیت', render: (row) => row.location?.code ?? '—' },
  { key: 'onHand', header: 'موجودی', align: 'end', render: (row) => <span className="tabular">{formatQuantity(row.onHand)}</span> },
  { key: 'reserved', header: 'رزرو', align: 'end', render: (row) => <span className="tabular">{formatQuantity(row.reserved)}</span> },
  {
    key: 'available',
    header: 'قابل فروش',
    align: 'end',
    render: (row) => (
      <Badge tone={Number(row.available) > 0 ? 'success' : 'danger'}>
        <span className="tabular">{formatQuantity(row.available)}</span>
      </Badge>
    ),
  },
];

const ledgerColumns: readonly Column<LedgerRow>[] = [
  {
    key: 'createdAt',
    header: 'زمان',
    render: (row) => (row.createdAt === undefined ? '—' : formatJalaliDateTime(row.createdAt)),
  },
  { key: 'type', header: 'نوع', render: (row) => <Badge tone="info">{row.type}</Badge> },
  {
    key: 'product',
    header: 'کالا',
    render: (row) => row.variant?.name ?? row.variant?.code ?? '—',
  },
  { key: 'warehouse', header: 'انبار', render: (row) => row.warehouse?.name ?? '—' },
  {
    key: 'quantity',
    header: 'مقدار',
    align: 'end',
    render: (row) => <span className="tabular">{formatQuantity(row.quantity)}</span>,
  },
  {
    key: 'balanceAfter',
    header: 'مانده',
    align: 'end',
    render: (row) => (row.balanceAfter === undefined || row.balanceAfter === null ? '—' : <span className="tabular">{formatQuantity(row.balanceAfter)}</span>),
  },
];

const ADJUSTMENT_TYPES = [
  { value: 'increase', label: 'افزایش موجودی' },
  { value: 'decrease', label: 'کاهش موجودی' },
  { value: 'writeoff', label: 'کسر و دورریز' },
  { value: 'damage', label: 'آسیب‌دیدگی' },
  { value: 'correction', label: 'اصلاح شمارش' },
];

interface AdjustmentRow {
  readonly key: string;
  variantId: string;
  quantity: string;
}

let adjustmentKeySeed = 0;

/** Inventory screen: balances + ledger tabs and a stock adjustment modal. */
export function InventoryPage() {
  useDocumentTitle('انبار و موجودی');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('balances');
  const [warehouseId, setWarehouseId] = useState('');
  const [ledgerRange, setLedgerRange] = useState<DateRangeISO>(() => lastNDaysISO(30));
  const [ledgerType, setLedgerType] = useState('');
  const [page, setPage] = useState(1);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustWarehouseId, setAdjustWarehouseId] = useState('');
  const [adjustType, setAdjustType] = useState('increase');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustRows, setAdjustRows] = useState<readonly AdjustmentRow[]>(() => [
    { key: 'row-1', variantId: '', quantity: '' },
  ]);

  const canReadBalances = useHasPermission(PERM.inventoryBalanceRead);
  const canReadLedger = useHasPermission(PERM.inventoryLedgerRead);

  const warehousesQuery = useQuery({
    queryKey: queryKeys.warehouses.list,
    queryFn: () => api.get<readonly Warehouse[]>('/warehouses', { perPage: 100 }),
    staleTime: 5 * 60_000,
  });
  const warehouseOptions = (warehousesQuery.data ?? []).map((warehouse) => ({
    value: warehouse.id,
    label: warehouse.name ?? warehouse.code ?? warehouse.id,
  }));

  const balancesQuery = useQuery({
    queryKey: queryKeys.inventory.balances({ warehouseId, page }),
    queryFn: () =>
      api.getPage<BalanceRow>('/inventory/balances', {
        page,
        perPage: 25,
        includeZero: false,
        ...(warehouseId === '' ? {} : { 'filter[warehouseId]': warehouseId }),
      }),
    enabled: canReadBalances && tab === 'balances',
  });

  const ledgerQuery = useQuery({
    queryKey: queryKeys.inventory.ledger({ ...ledgerRange, ledgerType, warehouseId, page }),
    queryFn: () =>
      api.getPage<LedgerRow>('/inventory/ledger', {
        page,
        perPage: 25,
        'filter[createdAt][gte]': `${ledgerRange.from}T00:00:00Z`,
        'filter[createdAt][lt]': `${ledgerRange.to}T23:59:59Z`,
        ...(warehouseId === '' ? {} : { 'filter[warehouseId]': warehouseId }),
        ...(ledgerType === '' ? {} : { 'filter[type]': ledgerType }),
      }),
    enabled: canReadLedger && tab === 'ledger',
  });

  const variantsQuery = useQuery({
    queryKey: ['variants', 'adjustment-picker'],
    queryFn: () => api.getPage<VariantSummary>('/variants', { perPage: 100 }),
    enabled: adjustOpen,
    staleTime: 60_000,
  });
  const variantOptions = (variantsQuery.data?.items ?? []).map((variant) => ({
    value: variant.id,
    label: variant.sku,
    ...(variant.barcode === undefined || variant.barcode === null ? {} : { hint: variant.barcode }),
  }));

  const adjustmentMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string; status?: string }>(
        '/inventory/adjustments',
        {
          warehouseId: adjustWarehouseId,
          type: adjustType,
          reason: adjustReason.trim(),
          lines: adjustRows.map((row) => ({ variantId: row.variantId, quantity: row.quantity })),
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: (result) => {
      if (result.status === 'pending_approval') {
        toast.info('درخواست ثبت شد', 'این اصلاح موجودی برای تأیید ارسال شد.');
      } else {
        toast.success('اصلاح موجودی ثبت شد');
      }
      setAdjustOpen(false);
      setAdjustRows([{ key: `row-${++adjustmentKeySeed}`, variantId: '', quantity: '' }]);
      setAdjustReason('');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toast.error('ثبت اصلاح موجودی ناموفق بود', toFaErrorMessage(error)),
  });

  if (!canReadBalances && !canReadLedger) {
    return (
      <>
        <PageHeader title="انبار و موجودی" />
        <PermissionNotice permission={PERM.inventoryBalanceRead} />
      </>
    );
  }

  const activeQuery = tab === 'balances' ? balancesQuery : ledgerQuery;
  const adjustValid =
    adjustWarehouseId !== '' &&
    adjustReason.trim().length >= 3 &&
    adjustRows.every((row) => row.variantId !== '' && row.quantity !== '' && Number(row.quantity) > 0);

  return (
    <>
      <PageHeader
        title="انبار و موجودی"
        description="موجودی جاری، گردش انبار و اصلاح موجودی"
        actions={
          <Can permission={PERM.inventoryAdjust}>
            <Button icon={<ClipboardPlus className="size-4" />} onClick={() => setAdjustOpen(true)}>
              اصلاح موجودی
            </Button>
          </Can>
        }
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <Tabs
          ariaLabel="بخش‌های انبار"
          value={tab}
          onChange={(value) => {
            setTab(value);
            setPage(1);
          }}
          items={[
            ...(canReadBalances ? [{ value: 'balances', label: 'موجودی' }] : []),
            ...(canReadLedger ? [{ value: 'ledger', label: 'گردش انبار' }] : []),
          ]}
        />
        <div className="w-48">
          <Select
            aria-label="فیلتر انبار"
            options={[{ value: '', label: 'همه انبارها' }, ...warehouseOptions]}
            value={warehouseId}
            loading={warehousesQuery.isLoading}
            onChange={(event) => {
              setWarehouseId(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <TabPanel value={tab}>
        {tab === 'balances' && (
          <>
            {balancesQuery.isError ? (
              <ErrorState
                error={balancesQuery.error}
                onRetry={() => void balancesQuery.refetch()}
              />
            ) : (
              <DataTable
                columns={balanceColumns}
                rows={balancesQuery.data?.items ?? []}
                rowKey={(row) => row.id}
                loading={balancesQuery.isLoading}
                caption="موجودی انبار"
                emptyTitle="موجودی ثبت نشده است"
                emptyDescription="پس از ثبت رسید یا اصلاح موجودی، اطلاعات در این جدول نمایش داده می‌شود."
              />
            )}
            <Pagination
              mode="offset"
              page={page}
              perPage={25}
              {...(balancesQuery.data?.pagination?.total === undefined
                ? {}
                : { total: balancesQuery.data.pagination.total })}
              onPageChange={setPage}
              disabled={balancesQuery.isFetching}
            />
          </>
        )}

        {tab === 'ledger' && (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <DateRangePicker
                value={ledgerRange}
                onChange={(range) => {
                  setLedgerRange(range);
                  setPage(1);
                }}
              />
              <div className="w-40">
                <label htmlFor="ledger-type" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  نوع گردش
                </label>
                <Select
                  id="ledger-type"
                  options={[
                    { value: '', label: 'همه انواع' },
                    { value: 'receipt', label: 'رسید' },
                    { value: 'issue', label: 'حواله' },
                    { value: 'adjustment', label: 'اصلاح' },
                    { value: 'transfer', label: 'انتقال' },
                    { value: 'count', label: 'شمارش' },
                  ]}
                  value={ledgerType}
                  onChange={(event) => {
                    setLedgerType(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
            {ledgerQuery.isError ? (
              <ErrorState error={ledgerQuery.error} onRetry={() => void ledgerQuery.refetch()} />
            ) : (
              <DataTable
                columns={ledgerColumns}
                rows={ledgerQuery.data?.items ?? []}
                rowKey={(row) => row.id}
                loading={ledgerQuery.isLoading}
                caption="گردش انبار"
                emptyTitle="گردشی در این بازه ثبت نشده است"
                emptyDescription="بازه زمانی را تغییر دهید یا پس از ثبت تراکنش دوباره تلاش کنید."
              />
            )}
            <Pagination
              mode="offset"
              page={page}
              perPage={25}
              onPageChange={setPage}
              disabled={ledgerQuery.isFetching}
            />
          </>
        )}
      </TabPanel>

      {activeQuery.isError && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {toFaErrorMessage(activeQuery.error)}
        </p>
      )}

      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="اصلاح موجودی"
        description="اصلاح موجودی به‌صورت سند ثبت می‌شود و در صورت عبور از حد مجاز نیازمند تأیید است."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdjustOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={adjustmentMutation.isPending}
              disabled={!adjustValid}
              onClick={() => adjustmentMutation.mutate()}
            >
              ثبت اصلاح
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="انبار" required>
              <Select
                options={warehouseOptions}
                placeholder="انتخاب انبار"
                value={adjustWarehouseId}
                loading={warehousesQuery.isLoading}
                onChange={(event) => setAdjustWarehouseId(event.target.value)}
              />
            </FormField>
            <FormField label="نوع اصلاح" required>
              <Select
                options={ADJUSTMENT_TYPES}
                value={adjustType}
                onChange={(event) => setAdjustType(event.target.value)}
              />
            </FormField>
          </div>
          <FormField label="دلیل" required>
            <Textarea
              rows={2}
              value={adjustReason}
              onChange={(event) => setAdjustReason(event.target.value)}
              placeholder="دلیل اصلاح موجودی را بنویسید…"
            />
          </FormField>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">اقلام</span>
              <Button
                variant="outline"
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() =>
                  setAdjustRows((current) => [
                    ...current,
                    { key: `row-${++adjustmentKeySeed}`, variantId: '', quantity: '' },
                  ])
                }
              >
                افزودن قلم
              </Button>
            </div>
            {variantsQuery.isError && (
              <ErrorState message="دریافت فهرست تنوع‌ها ناموفق بود." onRetry={() => void variantsQuery.refetch()} />
            )}
            {adjustRows.map((row, index) => (
              <div key={row.key} className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_auto]">
                <FormField label={`کالا ${formatNumber(index + 1)}`} required>
                  <Combobox
                    options={variantOptions}
                    value={row.variantId}
                    onChange={(value) =>
                      setAdjustRows((current) =>
                        current.map((item) => (item.key === row.key ? { ...item, variantId: value } : item)),
                      )
                    }
                    loading={variantsQuery.isLoading}
                    placeholder="جستجوی شناسه کالا"
                    ariaLabel="انتخاب کالا برای اصلاح موجودی"
                  />
                </FormField>
                <FormField label="مقدار" required>
                  <NumberInput
                    value={row.quantity}
                    min="0.0001"
                    onChange={(value) =>
                      setAdjustRows((current) =>
                        current.map((item) => (item.key === row.key ? { ...item, quantity: value } : item)),
                      )
                    }
                  />
                </FormField>
                <IconButton
                  label="حذف قلم"
                  tone="danger"
                  icon={<Trash2 className="size-4" />}
                  disabled={adjustRows.length === 1}
                  onClick={() => setAdjustRows((current) => current.filter((item) => item.key !== row.key))}
                />
              </div>
            ))}
          </div>

          {adjustRows.some((row) => row.variantId === '') || adjustReason.trim().length < 3 ? (
            <EmptyState
              title="اطلاعات سند کامل نیست"
              description="انبار، دلیل و حداقل یک قلم با مقدار را وارد کنید تا امکان ثبت فعال شود."
            />
          ) : null}
          {adjustmentMutation.isError && (
            <ErrorState error={adjustmentMutation.error} />
          )}
        </div>
      </Modal>
    </>
  );
}
