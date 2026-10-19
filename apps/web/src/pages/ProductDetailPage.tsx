import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ImagePlus, Plus, Send, Trash2 } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage, uploadFile } from '../lib/api-client';
import { formatJalali, formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { usePathParam } from '../lib/router';
import { useHasPermission } from '../lib/use-auth';
import type { ProductDetail, Unit, VariantSummary } from '../types/api';
import { Can } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FileDropzone } from '../components/ui/FileDropzone';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Tabs, TabPanel } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

const variantColumns: readonly Column<VariantSummary>[] = [
  { key: 'sku', header: 'شناسه تنوع', render: (variant) => <span dir="ltr">{variant.sku}</span> },
  { key: 'barcode', header: 'بارکد', render: (variant) => <span dir="ltr">{variant.barcode ?? '—'}</span> },
  { key: 'status', header: 'وضعیت', render: (variant) => (variant.status === undefined ? '—' : <StatusBadge status={variant.status} />) },
  {
    key: 'createdAt',
    header: 'تاریخ ایجاد',
    render: (variant) => (variant.createdAt === undefined ? '—' : formatJalali(variant.createdAt)),
  },
];

/** Product detail: master data, variants, media; actions are permission-gated. */
export function ProductDetailPage() {
  const id = usePathParam('id');
  useDocumentTitle('جزئیات کالا');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('info');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [variantSku, setVariantSku] = useState('');
  const [variantBarcode, setVariantBarcode] = useState('');
  const [variantUnitId, setVariantUnitId] = useState('');
  const [uploading, setUploading] = useState(false);

  const canUpdate = useHasPermission(PERM.productUpdate);
  const canAddVariant = useHasPermission(PERM.variantCreate);
  const canManageMedia = useHasPermission(PERM.mediaCreate);

  const productQuery = useQuery({
    queryKey: queryKeys.catalog.product(id),
    queryFn: () =>
      api.get<ProductDetail>(`/products/${id}`, {
        include: 'variants,media,attributes,suppliers',
      }),
  });
  const unitsQuery = useQuery({
    queryKey: queryKeys.catalog.units,
    queryFn: () => api.get<readonly Unit[]>('/units', { perPage: 200 }),
    staleTime: 5 * 60_000,
    enabled: variantModalOpen,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.product(id) });
  };

  const publishMutation = useMutation({
    mutationFn: () => api.post<ProductDetail>(`/products/${id}/publish`, {}),
    onSuccess: () => {
      toast.success('کالا منتشر شد');
      invalidate();
    },
    onError: (error) => toast.error('انتشار کالا ناموفق بود', toFaErrorMessage(error)),
  });

  const archiveMutation = useMutation({
    mutationFn: (reason?: string) =>
      api.post<ProductDetail>(`/products/${id}/archive`, { reason: reason ?? '' }),
    onSuccess: () => {
      toast.success('کالا بایگانی شد');
      setArchiveOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('بایگانی کالا ناموفق بود', toFaErrorMessage(error)),
  });

  const addVariantMutation = useMutation({
    mutationFn: () =>
      api.post<VariantSummary>(
        `/products/${id}/variants`,
        {
          sku: variantSku.trim(),
          ...(variantBarcode.trim() === '' ? {} : { barcode: variantBarcode.trim() }),
          unitId: variantUnitId,
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('تنوع جدید ثبت شد');
      setVariantModalOpen(false);
      setVariantSku('');
      setVariantBarcode('');
      setVariantUnitId('');
      invalidate();
    },
    onError: (error) => toast.error('ثبت تنوع ناموفق بود', toFaErrorMessage(error)),
  });

  const addMediaMutation = useMutation({
    mutationFn: (fileId: string) =>
      api.post(`/products/${id}/media`, { fileId }, { idempotencyKey: newRequestId() }),
    onSuccess: () => {
      toast.success('رسانه به کالا افزودن شد');
      invalidate();
    },
    onError: (error) => toast.error('افزودن رسانه ناموفق بود', toFaErrorMessage(error)),
  });

  const deleteMediaMutation = useMutation({
    mutationFn: (mediaId: string) => api.del(`/products/${id}/media/${mediaId}`),
    onSuccess: () => {
      toast.success('رسانه حذف شد');
      invalidate();
    },
    onError: (error) => toast.error('حذف رسانه ناموفق بود', toFaErrorMessage(error)),
  });

  if (productQuery.isLoading) {
    return <Card>در حال دریافت اطلاعات کالا…</Card>;
  }
  if (productQuery.isError || productQuery.data === undefined) {
    return (
      <ErrorState
        title="دریافت اطلاعات کالا ناموفق بود"
        error={productQuery.error}
        onRetry={() => void productQuery.refetch()}
      />
    );
  }

  const product = productQuery.data;
  const variants = product.variants ?? [];
  const media = product.media ?? [];

  return (
    <>
      <PageHeader
        title={product.nameFa}
        description={product.nameEn ?? undefined}
        breadcrumbs={[{ label: 'محصولات', to: '/products' }, { label: product.nameFa }]}
        actions={
          <>
            {canUpdate && product.status !== 'published' && product.status !== 'active' && (
              <Button
                icon={<Send className="size-4" />}
                loading={publishMutation.isPending}
                onClick={() => publishMutation.mutate()}
              >
                انتشار کالا
              </Button>
            )}
            {canUpdate && product.status !== 'archived' && (
              <Button
                variant="outline"
                icon={<Archive className="size-4" />}
                onClick={() => setArchiveOpen(true)}
              >
                بایگانی
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <StatusBadge status={typeof product.status === 'string' ? product.status : 'draft'} />
        {product.sku !== undefined && product.sku !== null && (
          <span dir="ltr" className="rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
            {product.sku}
          </span>
        )}
        {product.category !== undefined && product.category !== null && (
          <Badge tone="brand">{product.category.nameFa ?? product.category.name ?? 'دسته‌بندی'}</Badge>
        )}
        {product.brand !== undefined && product.brand !== null && (
          <Badge tone="info">{product.brand.nameFa ?? product.brand.name ?? 'برند'}</Badge>
        )}
      </div>

      <Tabs
        ariaLabel="بخش‌های کالا"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'info', label: 'اطلاعات' },
          { value: 'variants', label: 'تنوع‌ها', badge: <Badge>{variants.length.toLocaleString('fa-IR')}</Badge> },
          { value: 'media', label: 'رسانه', badge: <Badge>{media.length.toLocaleString('fa-IR')}</Badge> },
        ]}
      />

      <TabPanel value={tab}>
        {tab === 'info' && (
          <Card>
            <CardHeader title="اطلاعات پایه" />
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs text-slate-500">نام فارسی</dt>
                <dd>{product.nameFa}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">نام انگلیسی</dt>
                <dd dir="ltr" className="text-start">
                  {product.nameEn ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">دسته‌بندی</dt>
                <dd>{product.category?.nameFa ?? product.category?.name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">برند</dt>
                <dd>{product.brand?.nameFa ?? product.brand?.name ?? '—'}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="text-xs text-slate-500">توضیحات</dt>
                <dd className="whitespace-pre-wrap">{product.description ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">تاریخ ایجاد</dt>
                <dd>{product.createdAt === undefined ? '—' : formatJalaliDateTime(product.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">آخرین تغییر</dt>
                <dd>{product.updatedAt === undefined ? '—' : formatJalaliDateTime(product.updatedAt)}</dd>
              </div>
            </dl>
          </Card>
        )}

        {tab === 'variants' && (
          <Card>
            <CardHeader
              title="تنوع‌های کالا"
              actions={
                canAddVariant ? (
                  <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setVariantModalOpen(true)}>
                    افزودن تنوع
                  </Button>
                ) : undefined
              }
            />
            {variants.length === 0 ? (
              <EmptyState title="تنوعی برای این کالا ثبت نشده است" />
            ) : (
              <DataTable
                columns={variantColumns}
                rows={variants}
                rowKey={(variant) => variant.id}
                caption="تنوع‌های کالا"
              />
            )}
          </Card>
        )}

        {tab === 'media' && (
          <Card>
            <CardHeader title="رسانه کالا" />
            {canManageMedia && (
              <div className="mb-4">
                <FileDropzone
                  label="افزودن تصویر"
                  accept="image/*"
                  uploading={uploading}
                  files={[]}
                  onFiles={(files) => {
                    const file = files[0];
                    if (file === undefined) {
                      return;
                    }
                    setUploading(true);
                    void uploadFile(file, 'product_media')
                      .then((uploaded) => addMediaMutation.mutate(uploaded.id))
                      .catch((error: unknown) => {
                        toast.error('بارگذاری تصویر ناموفق بود', toFaErrorMessage(error));
                      })
                      .finally(() => setUploading(false));
                  }}
                />
              </div>
            )}
            {media.length === 0 ? (
              <EmptyState
                icon={<ImagePlus className="size-8" />}
                title="رسانه‌ای برای این کالا وجود ندارد"
                description="تصاویر کالا برای نمایش در کانال‌های فروش استفاده می‌شوند."
              />
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {media.map((item) => (
                  <li
                    key={item.id}
                    className="group relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
                  >
                    <div className="grid aspect-square place-items-center bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">
                      {item.downloadUrl !== undefined || item.url !== undefined ? (
                        <img
                          src={item.downloadUrl ?? item.url}
                          alt={item.alt ?? product.nameFa}
                          className="size-full object-cover"
                        />
                      ) : (
                        'بدون پیش‌نمایش'
                      )}
                    </div>
                    {item.isPrimary === true && (
                      <span className="absolute start-2 top-2">
                        <Badge tone="brand">اصلی</Badge>
                      </span>
                    )}
                    <Can permission={PERM.mediaCreate}>
                      <button
                        type="button"
                        aria-label="حذف رسانه"
                        onClick={() => deleteMediaMutation.mutate(item.id)}
                        className="absolute end-2 top-2 rounded-lg bg-white/90 p-1.5 text-red-600 shadow hover:bg-white"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </Can>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </TabPanel>

      <ConfirmDialog
        open={archiveOpen}
        title="بایگانی کالا"
        description="با بایگانی، ارسال کالا به کانال‌ها متوقف می‌شود اما تاریخچه حفظ می‌شود."
        confirmLabel="بایگانی کن"
        tone="danger"
        requireReason
        reasonLabel="دلیل بایگانی"
        loading={archiveMutation.isPending}
        onConfirm={(reason) => archiveMutation.mutate(reason)}
        onCancel={() => setArchiveOpen(false)}
      />

      <Modal
        open={variantModalOpen}
        onClose={() => setVariantModalOpen(false)}
        title="افزودن تنوع جدید"
        footer={
          <>
            <Button variant="outline" onClick={() => setVariantModalOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={addVariantMutation.isPending}
              disabled={
                variantSku.trim() === '' ||
                variantUnitId === '' ||
                unitsQuery.isError
              }
              onClick={() => addVariantMutation.mutate()}
            >
              ثبت تنوع
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {unitsQuery.isError && (
            <ErrorState message="دریافت واحدهای اندازه‌گیری ناموفق بود." onRetry={() => void unitsQuery.refetch()} />
          )}
          <FormField label="شناسه تنوع (SKU)" required>
            <Input
              dir="ltr"
              className="text-left"
              value={variantSku}
              onChange={(event) => setVariantSku(event.target.value)}
              placeholder="SKU-001"
            />
          </FormField>
          <FormField label="بارکد" hint="اختیاری">
            <Input
              dir="ltr"
              className="text-left"
              value={variantBarcode}
              onChange={(event) => setVariantBarcode(event.target.value)}
              placeholder="6260000000000"
            />
          </FormField>
          <FormField label="واحد اندازه‌گیری" required>
            <Select
              options={(unitsQuery.data ?? []).map((unit) => ({
                value: unit.id,
                label: unit.nameFa ?? unit.symbol ?? unit.id,
              }))}
              value={variantUnitId}
              placeholder="انتخاب واحد"
              onChange={(event) => setVariantUnitId(event.target.value)}
              loading={unitsQuery.isLoading}
            />
          </FormField>
        </div>
      </Modal>
    </>
  );
}
