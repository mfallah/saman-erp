import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { api, ApiError, isNotImplemented, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalali } from '../lib/dates';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { formatMoney, formatNumber, toPersianDigits } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasAnyPermission, useHasPermission } from '../lib/use-auth';
import type {
  ProductDetail,
  ProductSummary,
  PurchaseReceipt,
  PurchaseReceiptInput,
  PurchaseReceiptLabelLineInput,
  PurchaseReceiptLabelPreviewInput,
  VariantSummary,
  Warehouse,
} from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { MoneyInput } from '../components/ui/MoneyInput';
import { NumberInput } from '../components/ui/NumberInput';
import { PageHeader } from '../components/ui/PageHeader';
import { LabelPrintModal, receiptLabelsUrl } from '../components/labels';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

const PER_PAGE = 20;

interface ReceiptRowDraft {
  readonly id: string;
  readonly product: ProductSummary | null;
  readonly variantId: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly serials: string;
}

function newRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `row_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function emptyRow(): ReceiptRowDraft {
  return {
    id: newRowId(),
    product: null,
    variantId: '',
    quantity: '1',
    unitCost: '',
    serials: '',
  };
}

function productLabel(product: ProductSummary): string {
  return product.nameFa;
}

function variantLabel(variant: VariantSummary): string {
  return variant.barcode === undefined || variant.barcode === null
    ? variant.sku
    : `${variant.sku} · ${variant.barcode}`;
}

function safeMoney(value: string | undefined): string {
  if (value === undefined || value === '') {
    return '—';
  }
  try {
    return formatMoney(value);
  } catch {
    return toPersianDigits(value);
  }
}

function isPositiveQuantity(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

/** Splits the textarea into trimmed serials, one per line. */
function parseSerials(raw: string): readonly string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface ReceiptRowEditorProps {
  readonly row: ReceiptRowDraft;
  readonly index: number;
  readonly canRemove: boolean;
  readonly onChange: (id: string, patch: Partial<ReceiptRowDraft>) => void;
  readonly onRemove: (id: string) => void;
}

/**
 * One receipt line: product search → variant → quantity/unit cost → optional
 * serials. Product search reuses the catalog list endpoint; variants come from
 * the product detail (`include=variants`), which only needs `product.read`.
 */
function ReceiptRowEditor({ row, index, canRemove, onChange, onRemove }: ReceiptRowEditorProps) {
  const [search, setSearch] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);

  const productsQuery = useQuery({
    queryKey: queryKeys.catalog.products({ q: debouncedSearch.trim(), perPage: 8, source: 'purchase' }),
    queryFn: () =>
      api.getPage<ProductSummary>('/products', {
        q: debouncedSearch.trim(),
        perPage: 8,
      }),
    enabled: row.product === null && debouncedSearch.trim().length >= 2,
    staleTime: 30_000,
  });

  const productId = row.product?.id;
  const detailQuery = useQuery({
    queryKey: queryKeys.catalog.product(productId ?? ''),
    queryFn: () => api.get<ProductDetail>(`/products/${productId ?? ''}`, { include: 'variants' }),
    enabled: productId !== undefined,
    staleTime: 60_000,
  });

  const variants = detailQuery.data?.variants;

  // Auto-select the only variant so a single-SKU product needs one click.
  useEffect(() => {
    if (row.product === null || row.variantId !== '') {
      return;
    }
    if (variants === undefined || variants.length !== 1) {
      return;
    }
    const only = variants[0];
    if (only !== undefined) {
      onChange(row.id, { variantId: only.id });
    }
  }, [onChange, row.id, row.product, row.variantId, variants]);

  const variantOptions = useMemo(
    () => (variants ?? []).map((variant) => ({ value: variant.id, label: variantLabel(variant) })),
    [variants],
  );

  const results = productsQuery.data?.items ?? [];

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          سطر {formatNumber(index + 1)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 aria-hidden className="size-4" />}
          disabled={!canRemove}
          onClick={() => onRemove(row.id)}
        >
          حذف
        </Button>
      </div>

      <FormField label="کالا" required>
        {row.product === null ? (
          <div className="relative">
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setListOpen(true);
              }}
              onFocus={() => setListOpen(true)}
              placeholder="جستجوی نام یا SKU کالا…"
              aria-label={`جستجوی کالا برای سطر ${index + 1}`}
              startIcon={<Search aria-hidden className="size-4" />}
            />
            {listOpen && debouncedSearch.trim().length >= 2 && (
              <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {productsQuery.isFetching && (
                  <p className="px-3 py-2 text-xs text-slate-500">در حال جستجو…</p>
                )}
                {productsQuery.isError && (
                  <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
                    جستجوی کالا ناموفق بود.
                  </p>
                )}
                {!productsQuery.isFetching && !productsQuery.isError && results.length === 0 && (
                  <p className="px-3 py-2 text-xs text-slate-500">کالایی یافت نشد.</p>
                )}
                <ul className="max-h-60 overflow-auto p-1">
                  {results.map((product) => (
                    <li key={product.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(row.id, { product, variantId: '' });
                          setSearch('');
                          setListOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-start text-sm hover:bg-brand-50 dark:hover:bg-slate-800"
                      >
                        <span className="truncate">{productLabel(product)}</span>
                        {product.sku !== undefined && product.sku !== null && (
                          <span dir="ltr" className="shrink-0 font-mono text-[11px] text-slate-400">
                            {product.sku}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {productLabel(row.product)}
              </p>
              {row.product.sku !== undefined && row.product.sku !== null && (
                <p dir="ltr" className="font-mono text-[11px] text-slate-400">
                  {row.product.sku}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange(row.id, { product: null, variantId: '' });
                setSearch('');
              }}
            >
              تغییر
            </Button>
          </div>
        )}
      </FormField>

      {row.product !== null && (
        <FormField
          label="تنوع (SKU)"
          required
          error={
            detailQuery.isError
              ? 'دریافت تنوع‌های کالا ناموفق بود.'
              : detailQuery.isSuccess && variantOptions.length === 0
                ? 'برای این کالا تنوعی ثبت نشده است.'
                : undefined
          }
        >
          <Select
            aria-label={`انتخاب تنوع برای سطر ${index + 1}`}
            options={variantOptions}
            value={row.variantId}
            placeholder={detailQuery.isLoading ? 'در حال دریافت تنوع‌ها…' : 'انتخاب تنوع'}
            loading={detailQuery.isLoading}
            invalid={row.variantId === ''}
            onChange={(event) => onChange(row.id, { variantId: event.target.value })}
          />
        </FormField>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="مقدار" required>
          <NumberInput
            value={row.quantity}
            onChange={(value) => onChange(row.id, { quantity: value })}
            min="0"
            ariaLabel={`مقدار سطر ${index + 1}`}
            invalid={row.quantity !== '' && !isPositiveQuantity(row.quantity)}
          />
        </FormField>
        <FormField label="بهای واحد (اختیاری)">
          <MoneyInput
            value={row.unitCost}
            onChange={(value) => onChange(row.id, { unitCost: value })}
            ariaLabel={`بهای واحد سطر ${index + 1}`}
          />
        </FormField>
      </div>

      <FormField
        label="سریال‌ها (اختیاری)"
        hint="هر سریال را در یک خط وارد کنید."
      >
        <Textarea
          dir="ltr"
          className="text-left font-mono text-xs"
          rows={2}
          value={row.serials}
          onChange={(event) => onChange(row.id, { serials: event.target.value })}
          placeholder={'SN-0001\nSN-0002'}
          aria-label={`سریال‌های سطر ${index + 1}`}
        />
      </FormField>
    </div>
  );
}

/** Purchase receipts list plus the "new purchase" registration modal. */
export function PurchasingPage() {
  useDocumentTitle('خرید و ورود کالا');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasAnyPermission([PERM.purchaseOrderRead, PERM.inventoryBalanceRead]);
  const canReadWarehouses = useHasPermission(PERM.warehouseRead);
  const canPrintLabels = useHasPermission(PERM.labelRead);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [labelsFor, setLabelsFor] = useState<string | null>(null);
  const [labelPreview, setLabelPreview] = useState<PurchaseReceiptLabelPreviewInput | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [rows, setRows] = useState<readonly ReceiptRowDraft[]>(() => [emptyRow()]);
  const [formError, setFormError] = useState<string | null>(null);

  const receiptsQuery = useQuery({
    queryKey: queryKeys.purchasing.receipts({ page }),
    queryFn: () => api.getPage<PurchaseReceipt>('/purchasing/receipts', { page, perPage: PER_PAGE }),
    enabled: canRead,
    staleTime: 15_000,
  });

  const warehousesQuery = useQuery({
    queryKey: queryKeys.warehouses.list,
    queryFn: () => api.get<readonly Warehouse[]>('/warehouses', { perPage: 100 }),
    enabled: open && canReadWarehouses,
    staleTime: 5 * 60_000,
  });

  const updateRow = useCallback((id: string, patch: Partial<ReceiptRowDraft>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((current) => (current.length <= 1 ? current : current.filter((row) => row.id !== id)));
  }, []);

  const resetForm = useCallback(() => {
    setSupplierName('');
    setWarehouseId('');
    setRows([emptyRow()]);
    setFormError(null);
    setLabelPreview(null);
  }, []);

  const openModal = (): void => {
    resetForm();
    setOpen(true);
  };

  const createMutation = useMutation({
    mutationFn: (input: PurchaseReceiptInput) =>
      api.post<PurchaseReceipt>('/purchasing/receipts', input, { idempotencyKey: newRequestId() }),
    onSuccess: (receipt) => {
      const reference = receipt?.receiptNumber ?? receipt?.number ?? receipt?.id?.slice(0, 8);
      toast.success(
        'خرید ثبت شد',
        reference === undefined ? 'رسید خرید با موفقیت ثبت شد.' : `رسید ${reference} ثبت شد.`,
      );
      setOpen(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['purchasing', 'receipts'] });
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'ثبت رسید خرید هنوز در سامانه فعال نشده است.');
      } else {
        const detail = error instanceof ApiError ? error.details?.[0] : undefined;
      const fieldLabels: Record<string, string> = {
        supplierId: 'نام تأمین‌کننده',
        supplierName: 'نام تأمین‌کننده',
        warehouseId: 'انبار',
        lines: 'ردیف‌های کالا',
        variantId: 'کالا/تنوع',
        quantity: 'مقدار',
        unitCost: 'بهای واحد',
        serials: 'سریال‌ها',
        receivedAt: 'تاریخ رسید',
      };
      const field = detail?.field ?? (detail?.path?.length ? String(detail.path[detail.path.length - 1]) : undefined);
      const label = field === undefined ? undefined : fieldLabels[field];
      toast.error(
        'ثبت خرید ناموفق بود',
        label === undefined
          ? toFaErrorMessage(error)
          : `${label}: ${detail?.rule ?? 'مقدار واردشده معتبر نیست.'}`,
      );
      }
    },
  });

  const warehouses = warehousesQuery.data ?? [];
  const warehouseOptions = warehouses.map((warehouse) => ({
    value: warehouse.id,
    label: warehouse.name,
  }));

  /** Validates the line editors once for both save and label preview. */
  const collectReceiptLines = (): PurchaseReceiptInput['lines'] | null => {
    if (rows.length === 0) {
      setFormError('حداقل یک سطر کالا لازم است.');
      return null;
    }
    const invalid = rows.find(
      (row) => row.product === null || row.variantId === '' || !isPositiveQuantity(row.quantity),
    );
    if (invalid !== undefined) {
      setFormError('برای هر سطر، کالا، تنوع و مقدار معتبر لازم است.');
      return null;
    }
    for (const row of rows) {
      const serials = parseSerials(row.serials);
      if (serials.length > 0 && Number(row.quantity) !== serials.length) {
        setFormError(
          `تعداد سریال‌ها (${serials.length}) با مقدار کالا (${row.quantity}) برابر نیست؛ برای هر واحد دقیقاً یک سریال وارد کنید.`,
        );
        return null;
      }
    }
    return rows.map((row) => {
      const serials = parseSerials(row.serials);
      return {
        variantId: row.variantId,
        quantity: row.quantity,
        ...(row.unitCost === '' ? {} : { unitCost: row.unitCost }),
        ...(serials.length === 0 ? {} : { serials }),
      };
    });
  };

  const submit = (): void => {
    if (supplierName.trim().length < 2) {
      setFormError('نام تأمین‌کننده باید حداقل ۲ کاراکتر باشد.');
      return;
    }
    const lines = collectReceiptLines();
    if (lines === null) return;
    setFormError(null);
    createMutation.mutate({
      supplierName: supplierName.trim(),
      ...(warehouseId === '' ? {} : { warehouseId }),
      lines,
    });
  };

  /**
   * Prints labels from the current form before the receipt exists. The API
   * renders the same SVG sheet the saved-receipt endpoint returns.
   */
  const openLabelPreview = (): void => {
    const lines = collectReceiptLines();
    if (lines === null) return;
    const labelLines: PurchaseReceiptLabelLineInput[] = lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      ...(line.serials === undefined ? {} : { serials: line.serials }),
    }));
    setFormError(null);
    setLabelPreview({
      ...(warehouseId === '' ? {} : { warehouseId }),
      lines: labelLines,
    });
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="خرید و ورود کالا" />
        <PermissionNotice permission={PERM.purchaseOrderRead} />
      </>
    );
  }

  const voidMutation = useMutation({
    mutationFn: (receiptId: string) => api.post(`/purchasing/receipts/${receiptId}/void`, {}),
    onSuccess: () => {
      toast.success('رسید ابطال شد', 'موجودی معکوس و سریال‌ها باطل شدند.');
      void queryClient.invalidateQueries({ queryKey: ['purchasing', 'receipts'] });
      void queryClient.invalidateQueries();
    },
    onError: (error) => toast.error('ابطال رسید ناموفق بود', toFaErrorMessage(error)),
  });

  const detailQuery = useQuery({
    queryKey: ['purchasing', 'receipt', detailId ?? ''],
    queryFn: () => api.get<Record<string, unknown>>(`/purchasing/receipts/${detailId ?? ''}`),
    enabled: detailId !== null,
  });

  const columns: readonly Column<PurchaseReceipt>[] = [
    {
      key: 'number',
      header: 'شماره رسید',
      render: (receipt) => (
        <span dir="ltr" className="font-mono text-xs">
          {receipt.receiptNumber ?? receipt.number ?? receipt.id.slice(0, 8)}
        </span>
      ),
    },
    {
      key: 'supplier',
      header: 'تأمین‌کننده',
      render: (receipt) =>
        receipt.supplierName ??
        receipt.supplier?.nameFa ??
        receipt.supplier?.name ??
        '—',
    },
    {
      key: 'warehouse',
      header: 'انبار',
      render: (receipt) =>
        receipt.warehouse?.nameFa ?? receipt.warehouse?.name ?? receipt.warehouseName ?? '—',
    },
    {
      key: 'items',
      header: 'اقلام',
      align: 'center',
      render: (receipt) => formatNumber(receipt.itemCount ?? receipt.lines?.length ?? 0),
    },
    {
      key: 'total',
      header: 'مبلغ',
      align: 'end',
      render: (receipt) => <span className="tabular">{safeMoney(receipt.total ?? receipt.totalCost)}</span>,
    },
    {
      key: 'date',
      header: 'تاریخ ثبت',
      render: (receipt) => {
        const date = receipt.receivedAt ?? receipt.createdAt;
        return date === undefined ? '—' : formatJalali(date);
      },
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (receipt) => (receipt.status === undefined ? '—' : <StatusBadge status={receipt.status} />),
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (receipt) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => setDetailId(receipt.id)}>
            مشاهده
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLabelsFor(receipt.id)}>
            چاپ لیبل‌ها
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={voidMutation.isPending}
            onClick={() => {
              if (window.confirm(`رسید ${receipt.receiptNumber ?? receipt.id.slice(0, 8)} ابطال شود؟ موجودی معکوس می‌شود.`)) {
                voidMutation.mutate(receipt.id);
              }
            }}
          >
            ابطال
          </Button>
        </div>
      ),
    },
  ];

  const receipts = receiptsQuery.data?.items ?? [];
  const pagination = receiptsQuery.data?.pagination;

  return (
    <>
      <PageHeader
        title="خرید و ورود کالا"
        description="ثبت رسید خرید و مشاهده آخرین خریدها"
        breadcrumbs={[{ label: 'خرید' }, { label: 'خرید و ورود کالا' }]}
        actions={
          <Button
            icon={<PackagePlus aria-hidden className="size-4" />}
            onClick={openModal}
          >
            ثبت خرید جدید
          </Button>
        }
      />

      <Card>
        <CardHeader
          title="آخرین رسیدهای خرید"
          description="رسیدهای ثبت‌شده از این صفحه و سایر منابع خرید"
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void receiptsQuery.refetch()}
              loading={receiptsQuery.isFetching}
            >
              بازخوانی
            </Button>
          }
        />

        <DataTable
          columns={columns}
          rows={receipts}
          rowKey={(receipt) => receipt.id}
          loading={receiptsQuery.isLoading}
          error={receiptsQuery.isError ? receiptsQuery.error : undefined}
          onRetry={() => void receiptsQuery.refetch()}
          caption="رسیدهای خرید"
          emptyTitle="رسیدی ثبت نشده است"
          emptyDescription="با دکمه «ثبت خرید جدید» اولین رسید خرید را ثبت کنید."
        />

        {receiptsQuery.data !== undefined && (
          <Pagination
            mode="offset"
            page={page}
            perPage={PER_PAGE}
            {...(pagination?.total === undefined ? {} : { total: pagination.total })}
            {...(pagination?.totalPages === undefined ? {} : { totalPages: pagination.totalPages })}
            onPageChange={setPage}
            disabled={receiptsQuery.isFetching}
          />
        )}
      </Card>

      <Modal
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title="جزئیات رسید خرید"
        size="xl"
      >
        {detailQuery.isLoading ? (
          <p className="text-sm text-slate-500">در حال بارگذاری…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>شماره رسید: <span dir="ltr">{String(detailQuery.data?.['receiptNo'] ?? '—')}</span></div>
              <div>تأمین‌کننده: {String(detailQuery.data?.['supplierName'] ?? '—')}</div>
              <div>وضعیت: {String(detailQuery.data?.['status'] ?? '—')}</div>
              <div>تاریخ: {String(detailQuery.data?.['receivedAt'] ?? '—')}</div>
            </div>
            <table className="w-full text-xs">
              <thead><tr><th className="p-1 text-right">کالا</th><th className="p-1">مقدار</th><th className="p-1">بهای واحد</th><th className="p-1">سریال‌ها</th></tr></thead>
              <tbody>
                {((detailQuery.data?.['lines'] as readonly Record<string, unknown>[] | undefined) ?? []).map((line, index) => (
                  <tr key={index} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-1 text-right">{String(line['productName'] ?? line['sku'] ?? line['variantId'] ?? '—')}</td>
                    <td className="p-1 text-center tabular">{String(line['acceptedQty'] ?? line['quantity'] ?? '—')}</td>
                    <td className="p-1 text-center tabular">{String(line['unitCost'] ?? line['unitCostAmount'] ?? '—')}</td>
                    <td className="p-1 text-center" dir="ltr">{(line['serials'] as readonly { serialNo?: string }[] | undefined)?.map((serial) => serial.serialNo).filter(Boolean).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <LabelPrintModal
        open={labelsFor !== null}
        onClose={() => setLabelsFor(null)}
        labelUrls={labelsFor === null ? [] : [receiptLabelsUrl(labelsFor)]}
        title="چاپ لیبل محصولات رسید"
        description="یک برچسب به‌ازای هر سریال یا هر واحد پذیرفته‌شده."
      />

      <LabelPrintModal
        open={labelPreview !== null}
        onClose={() => setLabelPreview(null)}
        labelUrls={[]}
        labelRequests={
          labelPreview === null
            ? []
            : [{ url: '/goods-receipts/labels/preview', body: labelPreview }]
        }
        title="چاپ لیبل پیش از ثبت خرید"
        description="برچسب اقلام همین فرم، بدون ثبت رسید و بدون تغییر موجودی."
      />

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          resetForm();
        }}
        title="ثبت خرید جدید"
        description="تأمین‌کننده، کالاها و مقدار/بهای هر سطر را وارد کنید."
        size="xl"
        closeOnOverlay={!createMutation.isPending}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
              disabled={createMutation.isPending}
            >
              انصراف
            </Button>
            {canPrintLabels && (
              <Button
                type="button"
                variant="outline"
                icon={<Printer aria-hidden className="size-4" />}
                onClick={openLabelPreview}
                disabled={createMutation.isPending}
              >
                چاپ لیبل
              </Button>
            )}
            <Button
              type="submit"
              form="purchase-receipt-form"
              loading={createMutation.isPending}
              icon={<PackagePlus aria-hidden className="size-4" />}
            >
              ثبت خرید
            </Button>
          </>
        }
      >
        <form
          id="purchase-receipt-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="نام تأمین‌کننده" required>
              <Input
                value={supplierName}
                onChange={(event) => setSupplierName(event.target.value)}
                placeholder="مثلاً فروشگاه لوازم خانگی آرین"
                aria-label="نام تأمین‌کننده"
                autoFocus
              />
            </FormField>
            {canReadWarehouses && (
              <FormField label="انبار (اختیاری)">
                <Select
                  aria-label="انتخاب انبار"
                  options={warehouseOptions}
                  value={warehouseId}
                  placeholder="انبار پیش‌فرض"
                  loading={warehousesQuery.isLoading}
                  onChange={(event) => setWarehouseId(event.target.value)}
                />
              </FormField>
            )}
          </div>

          <div className="space-y-3">
            {rows.map((row, index) => (
              <ReceiptRowEditor
                key={row.id}
                row={row}
                index={index}
                canRemove={rows.length > 1}
                onChange={updateRow}
                onRemove={removeRow}
              />
            ))}
          </div>

          <Button
            variant="outline"
            icon={<Plus aria-hidden className="size-4" />}
            onClick={() => setRows((current) => [...current, emptyRow()])}
          >
            افزودن سطر
          </Button>

          {formError !== null && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {formError}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
