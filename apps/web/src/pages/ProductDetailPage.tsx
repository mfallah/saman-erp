import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ImagePlus, Link2, Pencil, Plus, Printer, Send, Trash2, Unlink } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage, uploadFile } from '../lib/api-client';
import { formatJalali, formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { usePathParam } from '../lib/router';
import { useHasPermission } from '../lib/use-auth';
import type { CategoryNode, Channel, ChannelAccount, ProductDetail, Unit, VariantSummary } from '../types/api';
import { Can, PermissionNotice } from '../components/auth/Can';
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
import { LabelPrintModal, variantLabelUrl } from '../components/labels';
import { useToast } from '../components/ui/Toast';

interface ChannelMappingView {
  readonly id: string;
  readonly accountId: string;
  readonly accountName?: string | null;
  readonly channelCode?: string | null;
  readonly channelName?: string | null;
  readonly externalProductId?: string | null;
  readonly externalVariantId?: string | null;
  readonly externalSku?: string | null;
  readonly syncStatus?: string | null;
  readonly lastSyncedAt?: string | null;
  readonly variantId?: string | null;
  readonly variantSku?: string | null;
  readonly variantTitle?: string | null;
  readonly productName?: string | null;
  readonly isMapped?: boolean;
}

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

const EDITABLE_STATUSES = [
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
  { value: 'discontinued', label: 'متوقف‌شده' },
] as const;

/** Maps API statuses that are not directly editable (published/archived) to their editable base. */
function editableStatus(status: string): string {
  if (status === 'published') return 'active';
  if (status === 'archived') return 'inactive';
  return EDITABLE_STATUSES.some((option) => option.value === status) ? status : 'draft';
}

function flattenCategories(nodes: readonly CategoryNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((node) => [
    { value: node.id, label: `${'— '.repeat(depth)}${node.nameFa ?? node.name ?? node.id}` },
    ...flattenCategories(node.children ?? [], depth + 1),
  ]);
}

/** Product detail: master data, variants, media; actions are permission-gated. */
export function ProductDetailPage() {
  const id = usePathParam('id');
  useDocumentTitle('جزئیات کالا');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('info');
  const [labelVariantId, setLabelVariantId] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [variantSku, setVariantSku] = useState('');
  const [variantBarcode, setVariantBarcode] = useState('');
  const [variantUnitId, setVariantUnitId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [channelVariantId, setChannelVariantId] = useState('');
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [mappingChannelId, setMappingChannelId] = useState('');
  const [mappingAccountId, setMappingAccountId] = useState('');
  const [mappingSearch, setMappingSearch] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editNameFa, setEditNameFa] = useState('');
  const [editNameEn, setEditNameEn] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editStatus, setEditStatus] = useState('draft');
  const [editVariant, setEditVariant] = useState<VariantSummary | null>(null);
  const [editVariantSku, setEditVariantSku] = useState('');
  const [editVariantBarcode, setEditVariantBarcode] = useState('');

  const canUpdate = useHasPermission(PERM.productUpdate);
  const canAddVariant = useHasPermission(PERM.variantCreate);
  const canManageMedia = useHasPermission(PERM.mediaCreate);
  const canReadMappings = useHasPermission(PERM.mappingRead);
  const canLinkMapping = useHasPermission(PERM.mappingCreate);
  const canUnlinkMapping = useHasPermission(PERM.mappingDelete);

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
  const categoriesQuery = useQuery({
    queryKey: queryKeys.catalog.categories,
    queryFn: () => api.get<readonly CategoryNode[]>('/categories', { tree: true }),
    staleTime: 5 * 60_000,
    enabled: editOpen,
  });

  const channelVariants = productQuery.data?.variants ?? [];
  const activeChannelVariantId = channelVariantId || channelVariants[0]?.id || '';

  const channelMappingsQuery = useQuery({
    queryKey: ['channel-mappings', 'variant', activeChannelVariantId],
    queryFn: () =>
      api.get<readonly ChannelMappingView[]>(
        `/variants/${activeChannelVariantId}/channel-mappings`,
      ),
    enabled: tab === 'channels' && activeChannelVariantId !== '' && canReadMappings,
  });
  const channelsQuery = useQuery({
    queryKey: queryKeys.channels.list,
    queryFn: () => api.get<readonly Channel[]>('/channels', { perPage: 100 }),
    staleTime: 5 * 60_000,
    enabled: linkModalOpen,
  });
  const channelAccountsQuery = useQuery({
    queryKey: queryKeys.channels.accounts(mappingChannelId),
    queryFn: () =>
      api.get<readonly ChannelAccount[]>(`/channels/${mappingChannelId}/accounts`, {
        perPage: 100,
      }),
    enabled: linkModalOpen && mappingChannelId !== '',
  });
  const importedProductsQuery = useQuery({
    queryKey: [
      'channel-mappings',
      'imported',
      mappingAccountId,
      activeChannelVariantId,
      mappingSearch,
    ],
    queryFn: () =>
      api.get<readonly ChannelMappingView[]>('/channel-mappings', {
        accountId: mappingAccountId,
        search: mappingSearch.trim(),
        unmapped: true,
        variantId: activeChannelVariantId,
      }),
    enabled:
      linkModalOpen &&
      mappingAccountId !== '' &&
      activeChannelVariantId !== '' &&
      canReadMappings,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.product(id) });
  };
  const invalidateChannelMappings = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['channel-mappings'] });
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

  const updateProductMutation = useMutation({
    mutationFn: () => {
      const version = productQuery.data?.version;
      return api.patch<ProductDetail>(
        `/products/${id}`,
        {
          nameFa: editNameFa.trim(),
          nameEn: editNameEn.trim(),
          categoryId: editCategoryId,
          status: editStatus,
        },
        version === undefined ? undefined : { ifMatch: version },
      );
    },
    onSuccess: () => {
      toast.success('کالا ویرایش شد');
      setEditOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('ویرایش کالا ناموفق بود', toFaErrorMessage(error)),
  });

  const updateVariantMutation = useMutation({
    mutationFn: (variant: VariantSummary) => {
      const barcode = editVariantBarcode.trim();
      return api.patch<VariantSummary>(
        `/products/${id}/variants/${variant.id}`,
        {
          sku: editVariantSku.trim(),
          barcode: barcode === '' ? null : barcode,
        },
        variant.version === undefined ? undefined : { ifMatch: variant.version },
      );
    },
    onSuccess: () => {
      toast.success('تنوع کالا ویرایش شد');
      setEditVariant(null);
      invalidate();
    },
    onError: (error) => toast.error('ویرایش تنوع ناموفق بود', toFaErrorMessage(error)),
  });

  const openEditProduct = (): void => {
    const current = productQuery.data;
    if (current === undefined) return;
    setEditNameFa(current.nameFa);
    setEditNameEn(current.nameEn ?? '');
    setEditCategoryId(current.category?.id ?? '');
    setEditStatus(editableStatus(current.status));
    setEditOpen(true);
  };

  const openEditVariant = (variant: VariantSummary): void => {
    setEditVariant(variant);
    setEditVariantSku(variant.sku);
    setEditVariantBarcode(variant.barcode ?? '');
  };

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

  const linkChannelMutation = useMutation({
    mutationFn: (externalProductId: string) =>
      api.post<{ id: string }>(
        '/channel-mappings/link',
        {
          accountId: mappingAccountId,
          externalProductId,
          variantId: activeChannelVariantId,
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('محصول کانال به تنوع کالا متصل شد');
      setLinkModalOpen(false);
      setMappingSearch('');
      invalidateChannelMappings();
    },
    onError: (error) => toast.error('اتصال محصول کانال ناموفق بود', toFaErrorMessage(error)),
  });

  const unlinkChannelMutation = useMutation({
    mutationFn: (mappingId: string) => api.del<void>(`/channel-mappings/${mappingId}`),
    onSuccess: () => {
      toast.success('اتصال کانال قطع شد');
      invalidateChannelMappings();
    },
    onError: (error) => toast.error('قطع اتصال کانال ناموفق بود', toFaErrorMessage(error)),
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
  const variants = channelVariants;
  const media = product.media ?? [];
  const categoryOptions = flattenCategories(categoriesQuery.data ?? []);
  const variantTableColumns: readonly Column<VariantSummary>[] = [
    ...variantColumns,
    {
      key: 'actions',
      header: 'عملیات',
      render: (variant) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            icon={<Printer className="size-3.5" />}
            onClick={async () => {
              try {
                if (variant.barcode === null || variant.barcode === undefined) {
                  await api.post(`/variants/${variant.id}/barcode/generate`, {}, { idempotencyKey: newRequestId() });
                  void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.product(id) });
                }
                setLabelVariantId(variant.id);
              } catch (error) {
                toast.error('تولید بارکد ناموفق بود', toFaErrorMessage(error));
              }
            }}
          >
            برچسب
          </Button>
          {canUpdate ? (
            <Button
              size="sm"
              variant="outline"
              icon={<Pencil className="size-3.5" />}
              onClick={() => openEditVariant(variant)}
            >
              ویرایش
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const channelMappingColumns: readonly Column<ChannelMappingView>[] = [
    {
      key: 'channel',
      header: 'کانال',
      render: (mapping) => mapping.channelName ?? mapping.channelCode ?? '—',
    },
    {
      key: 'account',
      header: 'حساب',
      render: (mapping) => mapping.accountName ?? '—',
    },
    {
      key: 'externalProduct',
      header: 'شناسه محصول کانال',
      render: (mapping) => (
        <span dir="ltr" className="text-xs">
          {mapping.externalProductId ?? '—'}
        </span>
      ),
    },
    {
      key: 'externalVariant',
      header: 'شناسه تنوع کانال',
      render: (mapping) => (
        <span dir="ltr" className="text-xs">
          {mapping.externalVariantId ?? mapping.externalSku ?? '—'}
        </span>
      ),
    },
    {
      key: 'syncStatus',
      header: 'وضعیت همگام‌سازی',
      render: (mapping) =>
        mapping.syncStatus === undefined || mapping.syncStatus === null ? (
          '—'
        ) : (
          <StatusBadge status={mapping.syncStatus} />
        ),
    },
    {
      key: 'lastSyncedAt',
      header: 'آخرین همگام‌سازی',
      render: (mapping) =>
        mapping.lastSyncedAt === undefined || mapping.lastSyncedAt === null
          ? '—'
          : formatJalaliDateTime(mapping.lastSyncedAt),
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (mapping) =>
        canUnlinkMapping ? (
          <Button
            size="sm"
            variant="outline"
            icon={<Unlink className="size-3.5" />}
            loading={unlinkChannelMutation.isPending}
            onClick={() => unlinkChannelMutation.mutate(mapping.id)}
          >
            قطع اتصال
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title={product.nameFa}
        description={product.nameEn ?? undefined}
        breadcrumbs={[{ label: 'محصولات', to: '/products' }, { label: product.nameFa }]}
        actions={
          <>
            {canUpdate && (
              <Button
                variant="outline"
                icon={<Pencil className="size-4" />}
                onClick={openEditProduct}
              >
                ویرایش
              </Button>
            )}
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
          { value: 'channels', label: 'کانال‌ها' },
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
                columns={variantTableColumns}
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

        {tab === 'channels' && (
          <Card>
            <CardHeader
              title="کانال‌های متصل"
              description="محصولات واردشده از کانال‌ها را به تنوع کالای مرجع متصل کنید."
              actions={
                canLinkMapping ? (
                  <Button
                    size="sm"
                    icon={<Link2 className="size-4" />}
                    disabled={activeChannelVariantId === ''}
                    onClick={() => setLinkModalOpen(true)}
                  >
                    اتصال به محصول کانال
                  </Button>
                ) : undefined
              }
            />
            {variants.length === 0 ? (
              <EmptyState
                title="تنوعی برای این کالا ثبت نشده است"
                description="برای اتصال به کانال، ابتدا یک تنوع برای کالا ایجاد کنید."
              />
            ) : !canReadMappings ? (
              <PermissionNotice permission={PERM.mappingRead} />
            ) : (
              <>
                <div className="mb-4 max-w-sm">
                  <FormField label="تنوع کالا" hint="اتصال‌ها برای تنوع انتخاب‌شده نمایش داده می‌شوند.">
                    <Select
                      options={variants.map((variant) => ({
                        value: variant.id,
                        label: variant.sku,
                      }))}
                      value={activeChannelVariantId}
                      onChange={(event) => setChannelVariantId(event.target.value)}
                    />
                  </FormField>
                </div>
                {channelMappingsQuery.isError ? (
                  <ErrorState
                    error={channelMappingsQuery.error}
                    onRetry={() => void channelMappingsQuery.refetch()}
                  />
                ) : (
                  <DataTable
                    columns={channelMappingColumns}
                    rows={channelMappingsQuery.data ?? []}
                    rowKey={(mapping) => mapping.id}
                    loading={channelMappingsQuery.isLoading}
                    caption="کانال‌های متصل به تنوع کالا"
                    emptyTitle="این تنوع به کانالی متصل نیست"
                    emptyDescription="با دکمه «اتصال به محصول کانال» یکی از محصولات واردشده را به این تنوع متصل کنید."
                  />
                )}
              </>
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

      <Modal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        title="اتصال به محصول کانال"
        description="محصول واردشده از کانال را به تنوع انتخاب‌شده این کالا متصل کنید."
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setLinkModalOpen(false)}>
            بستن
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="کانال" required>
              <Select
                options={(channelsQuery.data ?? []).map((channel) => ({
                  value: channel.id,
                  label: channel.nameFa ?? channel.name ?? channel.code,
                }))}
                value={mappingChannelId}
                placeholder="انتخاب کانال"
                loading={channelsQuery.isLoading}
                onChange={(event) => {
                  setMappingChannelId(event.target.value);
                  setMappingAccountId('');
                  setMappingSearch('');
                }}
              />
            </FormField>
            <FormField label="حساب کانال" required>
              <Select
                options={(channelAccountsQuery.data ?? []).map((account) => ({
                  value: account.id,
                  label: account.nameFa ?? account.name ?? account.id,
                }))}
                value={mappingAccountId}
                placeholder={
                  mappingChannelId === '' ? 'ابتدا کانال را انتخاب کنید' : 'انتخاب حساب کانال'
                }
                disabled={mappingChannelId === ''}
                loading={channelAccountsQuery.isLoading}
                onChange={(event) => setMappingAccountId(event.target.value)}
              />
            </FormField>
          </div>

          {channelsQuery.isError && (
            <ErrorState
              message="دریافت کانال‌ها ناموفق بود."
              error={channelsQuery.error}
              onRetry={() => void channelsQuery.refetch()}
            />
          )}
          {channelAccountsQuery.isError && (
            <ErrorState
              message="دریافت حساب‌های کانال ناموفق بود."
              error={channelAccountsQuery.error}
              onRetry={() => void channelAccountsQuery.refetch()}
            />
          )}

          <FormField label="جستجوی محصول کانال" hint="نام، شناسه محصول یا شناسه تنوع کانال">
            <Input
              value={mappingSearch}
              onChange={(event) => setMappingSearch(event.target.value)}
              placeholder="جستجو…"
              disabled={mappingAccountId === ''}
            />
          </FormField>

          {mappingAccountId === '' ? (
            <EmptyState
              icon={<Link2 className="size-8" />}
              title="حساب کانال را انتخاب کنید"
              description="پس از انتخاب حساب، محصولات واردشده از آن کانال نمایش داده می‌شوند."
            />
          ) : importedProductsQuery.isError ? (
            <ErrorState
              error={importedProductsQuery.error}
              onRetry={() => void importedProductsQuery.refetch()}
            />
          ) : importedProductsQuery.isLoading ? (
            <p className="text-sm text-slate-500">در حال دریافت محصولات کانال…</p>
          ) : (importedProductsQuery.data ?? []).length === 0 ? (
            <EmptyState
              icon={<Link2 className="size-8" />}
              title="محصول واردشده‌ای برای اتصال پیدا نشد"
              description="همه محصولات این حساب به تنوع فعلی متصل هستند یا با عبارت جستجو مطابقت ندارند."
            />
          ) : (
            <ul className="space-y-2">
              {(importedProductsQuery.data ?? []).map((mapping) => (
                <li
                  key={mapping.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {mapping.productName ?? mapping.externalProductId ?? '—'}
                    </p>
                    <p dir="ltr" className="truncate text-xs text-slate-500">
                      {mapping.externalProductId ?? '—'}
                      {mapping.externalSku === undefined || mapping.externalSku === null
                        ? ''
                        : ` · ${mapping.externalSku}`}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {mapping.variantSku === undefined || mapping.variantSku === null
                        ? 'بدون اتصال'
                        : `اکنون متصل به ${mapping.variantSku}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    loading={linkChannelMutation.isPending}
                    disabled={
                      mapping.externalProductId === undefined ||
                      mapping.externalProductId === null
                    }
                    onClick={() => linkChannelMutation.mutate(mapping.externalProductId ?? '')}
                  >
                    اتصال
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="ویرایش کالا"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={updateProductMutation.isPending}
              disabled={
                editNameFa.trim() === '' ||
                editCategoryId === '' ||
                categoriesQuery.isError
              }
              onClick={() => updateProductMutation.mutate()}
            >
              ذخیره تغییرات
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {categoriesQuery.isError && (
            <ErrorState
              message="دریافت دسته‌بندی‌ها ناموفق بود."
              error={categoriesQuery.error}
              onRetry={() => void categoriesQuery.refetch()}
            />
          )}
          <FormField label="نام فارسی" required>
            <Input
              value={editNameFa}
              onChange={(event) => setEditNameFa(event.target.value)}
              placeholder="نام کالا"
            />
          </FormField>
          <FormField label="نام انگلیسی" hint="اختیاری">
            <Input
              dir="ltr"
              className="text-left"
              value={editNameEn}
              onChange={(event) => setEditNameEn(event.target.value)}
              placeholder="Product name"
            />
          </FormField>
          <FormField label="دسته‌بندی" required>
            <Select
              options={categoryOptions}
              value={editCategoryId}
              placeholder="انتخاب دسته‌بندی"
              loading={categoriesQuery.isLoading}
              disabled={categoriesQuery.isError}
              onChange={(event) => setEditCategoryId(event.target.value)}
            />
          </FormField>
          <FormField label="وضعیت" required>
            <Select
              options={EDITABLE_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
              value={editStatus}
              onChange={(event) => setEditStatus(event.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={editVariant !== null}
        onClose={() => setEditVariant(null)}
        title="ویرایش تنوع کالا"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditVariant(null)}>
              انصراف
            </Button>
            <Button
              loading={updateVariantMutation.isPending}
              disabled={editVariantSku.trim() === ''}
              onClick={() => {
                if (editVariant !== null) updateVariantMutation.mutate(editVariant);
              }}
            >
              ذخیره تغییرات
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="شناسه تنوع (SKU)" required>
            <Input
              dir="ltr"
              className="text-left"
              value={editVariantSku}
              onChange={(event) => setEditVariantSku(event.target.value)}
              placeholder="SKU-001"
            />
          </FormField>
          <FormField label="بارکد" hint="برای حذف بارکد، مقدار را خالی بگذارید.">
            <Input
              dir="ltr"
              className="text-left"
              value={editVariantBarcode}
              onChange={(event) => setEditVariantBarcode(event.target.value)}
              placeholder="6260000000000"
            />
          </FormField>
        </div>
      </Modal>
      <LabelPrintModal
        open={labelVariantId !== null}
        onClose={() => setLabelVariantId(null)}
        labelUrls={labelVariantId === null ? [] : [variantLabelUrl(labelVariantId)]}
        title="چاپ برچسب کالا"
        description="بارکد، SKU و نام کالا در برچسب چاپ می‌شود."
      />
    </>
  );
}
