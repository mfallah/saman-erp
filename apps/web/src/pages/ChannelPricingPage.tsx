import { useEffect, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeDollarSign, Calculator, Save, Search } from 'lucide-react';
import { api, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime } from '../lib/dates';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { formatMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  ChannelPricingPolicy,
  ChannelPricingPolicyRow,
  CostSource,
  PricePreview,
  PricingMode,
  ProductSummary,
  RoundingStep,
  VariantSummary,
} from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';

interface PolicyForm {
  readonly mode: PricingMode;
  readonly costSource: CostSource;
  readonly marginPercent: string;
  readonly commissionPercent: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly fixedCommission: string;
  readonly vatPercent: string;
  readonly rounding: RoundingStep;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODE_OPTIONS = [
  { value: 'margin', label: 'حاشیه سود (کِرَکسی): هزینه خرید + سود' },
  { value: 'cost_plus_fees', label: 'هزینه + کارمزد (دیجی‌کالا): تقسیم بر (۱ − کمیسیون)' },
];

const COST_SOURCE_OPTIONS = [
  { value: 'last_purchase', label: 'آخرین خرید' },
  { value: 'avg_cost', label: 'میانگین بهای تمام‌شده' },
  { value: 'manual', label: 'دستی (آخرین بهای ثبت‌شده)' },
];

const ROUNDING_OPTIONS = [
  { value: 'none', label: 'بدون گرد کردن' },
  { value: '1000', label: 'نزدیک‌ترین ۱٬۰۰۰ ریال' },
  { value: '500', label: 'نزدیک‌ترین ۵۰۰ ریال' },
];

function formFromPolicy(policy: ChannelPricingPolicy): PolicyForm {
  return {
    mode: policy.mode,
    costSource: policy.costSource,
    marginPercent: String(policy.marginPercent),
    commissionPercent: String(policy.commissionPercent),
    processingFee: String(policy.processingFee),
    shippingFee: String(policy.shippingFee),
    fixedCommission: String(policy.fixedCommission),
    vatPercent: String(policy.vatPercent),
    rounding: policy.rounding,
  };
}

function validateForm(form: PolicyForm): string | null {
  const values = [
    form.marginPercent,
    form.commissionPercent,
    form.processingFee,
    form.shippingFee,
    form.fixedCommission,
    form.vatPercent,
  ].map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return 'همه مقادیر باید عددی و بزرگ‌تر یا مساوی صفر باشند.';
  }
  if (Number(form.commissionPercent) >= 100) {
    return 'درصد کمیسیون باید کمتر از ۱۰۰ باشد.';
  }
  return null;
}

function bodyFromForm(form: PolicyForm): Omit<ChannelPricingPolicy, 'updatedAt'> {
  return {
    mode: form.mode,
    costSource: form.costSource,
    marginPercent: Number(form.marginPercent),
    commissionPercent: Number(form.commissionPercent),
    processingFee: Number(form.processingFee),
    shippingFee: Number(form.shippingFee),
    fixedCommission: Number(form.fixedCommission),
    vatPercent: Number(form.vatPercent),
    rounding: form.rounding,
  };
}

function BreakdownRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1.5 text-xs last:border-0 dark:border-slate-800">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  );
}

/** Per-channel pricing policy editor with a live variant preview. */
export function ChannelPricingPage() {
  useDocumentTitle('قیمت‌گذاری کانال‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.accountRead);
  const canEdit = useHasPermission(PERM.accountUpdate);

  const [channelId, setChannelId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [form, setForm] = useState<PolicyForm>({
    mode: 'margin',
    costSource: 'last_purchase',
    marginPercent: '0',
    commissionPercent: '0',
    processingFee: '0',
    shippingFee: '0',
    fixedCommission: '0',
    vatPercent: '0',
    rounding: 'none',
  });
  const [productSearch, setProductSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [variantId, setVariantId] = useState('');
  const debouncedSearch = useDebouncedValue(productSearch, 350);

  const policiesQuery = useQuery({
    queryKey: queryKeys.channels.allPricingPolicies,
    queryFn: () => api.get<readonly ChannelPricingPolicyRow[]>('/pricing/policies'),
    enabled: canRead,
  });
  const allPolicies = policiesQuery.data ?? [];
  const channelOptions = [
    ...new Map(
      allPolicies.map((row) => [
        row.channelId,
        { value: row.channelId, label: row.channelName },
      ]),
    ).values(),
  ];
  const policies = allPolicies.filter((row) => row.channelId === channelId);
  const selectedPolicy = policies.find((row) => row.accountId === accountId);

  useEffect(() => {
    if (channelId === '' && channelOptions[0] !== undefined) {
      setChannelId(channelOptions[0].value);
    }
  }, [channelId, channelOptions]);

  useEffect(() => {
    if (policies.length === 0) {
      if (accountId !== '') setAccountId('');
      return;
    }
    if (!policies.some((row) => row.accountId === accountId)) {
      setAccountId(policies[0]?.accountId ?? '');
    }
  }, [accountId, policies]);

  useEffect(() => {
    if (selectedPolicy !== undefined) setForm(formFromPolicy(selectedPolicy.policy));
  }, [selectedPolicy?.accountId, selectedPolicy?.policy.updatedAt]);

  const productsQuery = useQuery({
    queryKey: queryKeys.catalog.products({ q: debouncedSearch, pricingPicker: true }),
    queryFn: () => api.getPage<ProductSummary>('/products', { q: debouncedSearch, perPage: 8 }),
    enabled: canRead && debouncedSearch.trim().length >= 2,
  });
  const variantsQuery = useQuery({
    queryKey: queryKeys.catalog.variants(productId),
    queryFn: () => api.get<readonly VariantSummary[]>(`/products/${productId}/variants`, { perPage: 100 }),
    enabled: canRead && productId !== '',
  });
  const previewQuery = useQuery({
    queryKey: queryKeys.channels.pricePreview(accountId, variantId),
    queryFn: () => api.get<PricePreview>('/pricing/preview', { variantId, accountId }),
    enabled: canRead && accountId !== '' && UUID_PATTERN.test(variantId.trim()),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put<ChannelPricingPolicy>(
        `/channel-accounts/${accountId}/pricing-policy`,
        bodyFromForm(form),
      ),
    onSuccess: (policy) => {
      setForm(formFromPolicy(policy));
      toast.success('سیاست قیمت‌گذاری ذخیره شد');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.allPricingPolicies });
      void queryClient.invalidateQueries({ queryKey: ['pricing', 'preview'] });
    },
    onError: (error) => toast.error('ذخیره سیاست ناموفق بود', toFaErrorMessage(error)),
  });

  const save = (): void => {
    const validation = validateForm(form);
    if (validation !== null) {
      toast.error('ورودی نامعتبر', validation);
      return;
    }
    saveMutation.mutate();
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="قیمت‌گذاری کانال‌ها" />
        <PermissionNotice permission={PERM.accountRead} />
      </>
    );
  }

  const policyOptions = policies.map((row) => ({
    value: row.accountId,
    label: `${row.accountName}${row.isActive ? '' : ' (غیرفعال)'}`,
  }));
  const variants = variantsQuery.data ?? [];
  const preview = previewQuery.data;

  const update = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <>
      <PageHeader
        title="قیمت‌گذاری کانال‌ها"
        description="سیاست قیمت هر حساب فروش و پیش‌نمایش زنده بر اساس بهای خرید"
        breadcrumbs={[{ label: 'قیمت‌گذاری', to: '/pricing' }, { label: 'قیمت‌گذاری کانال‌ها' }]}
        actions={
          canEdit ? (
            <Button
              icon={<Save className="size-4" />}
              loading={saveMutation.isPending}
              disabled={accountId === ''}
              onClick={save}
            >
              ذخیره سیاست
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardHeader
            title="سیاست قیمت حساب کانال"
            description="این مقادیر در تنظیمات همان حساب ذخیره می‌شوند و بر قیمت پیشنهادی کانال اثر می‌گذارند."
            actions={selectedPolicy === undefined ? undefined : (
              <Badge tone={selectedPolicy.isActive ? 'success' : 'neutral'}>
                {selectedPolicy.channelCode}
              </Badge>
            )}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="کانال">
              <Select
                options={channelOptions}
                placeholder="انتخاب کانال"
                value={channelId}
                onChange={(event) => {
                  setChannelId(event.target.value);
                  setAccountId('');
                }}
              />
            </FormField>
            <FormField label="حساب فروشنده">
              <Select
                options={policyOptions}
                placeholder={channelId === '' ? 'ابتدا کانال را انتخاب کنید' : 'انتخاب حساب'}
                value={accountId}
                disabled={policyOptions.length === 0}
                onChange={(event) => setAccountId(event.target.value)}
              />
            </FormField>
          </div>

          {policiesQuery.isError ? (
            <ErrorState error={policiesQuery.error} onRetry={() => void policiesQuery.refetch()} />
          ) : channelId !== '' && policiesQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-slate-500">در حال دریافت حساب‌ها…</p>
          ) : policies.length === 0 ? (
            <EmptyState
              icon={<BadgeDollarSign className="size-8" />}
              title="حساب کانالی یافت نشد"
              description="برای تنظیم قیمت، ابتدا در صفحه یکپارچه‌سازی‌ها یک حساب فروشنده بسازید."
            />
          ) : (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="حالت محاسبه" hint="کِرَکسی: هزینه + سود؛ دیجی‌کالا: هزینه + کارمزدها با تقسیم بر (۱ − کمیسیون).">
                  <Select
                    options={MODE_OPTIONS}
                    value={form.mode}
                    disabled={!canEdit}
                    onChange={(event) => update('mode', event.target.value as PricingMode)}
                  />
                </FormField>
                <FormField label="منبع بهای خرید" hint="اگر بهای خرید ثبت نشده باشد، صفر در نظر گرفته می‌شود.">
                  <Select
                    options={COST_SOURCE_OPTIONS}
                    value={form.costSource}
                    disabled={!canEdit}
                    onChange={(event) => update('costSource', event.target.value as CostSource)}
                  />
                </FormField>
                <FormField label="درصد حاشیه سود" hint="درصدی از بهای خرید که به آن اضافه می‌شود.">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    dir="ltr"
                    value={form.marginPercent}
                    disabled={!canEdit}
                    onChange={(event) => update('marginPercent', event.target.value)}
                  />
                </FormField>
                <FormField label="درصد کمیسیون کانال" hint="فقط در حالت دیجی‌کالا؛ درصدی از قیمت فروش.">
                  <Input
                    type="number"
                    min="0"
                    max="99.99"
                    step="0.01"
                    dir="ltr"
                    value={form.commissionPercent}
                    disabled={!canEdit || form.mode === 'margin'}
                    onChange={(event) => update('commissionPercent', event.target.value)}
                  />
                </FormField>
                <FormField label="کارمزد پردازش (ریال)">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    dir="ltr"
                    value={form.processingFee}
                    disabled={!canEdit || form.mode === 'margin'}
                    onChange={(event) => update('processingFee', event.target.value)}
                  />
                </FormField>
                <FormField label="هزینه ارسال (ریال)">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    dir="ltr"
                    value={form.shippingFee}
                    disabled={!canEdit || form.mode === 'margin'}
                    onChange={(event) => update('shippingFee', event.target.value)}
                  />
                </FormField>
                <FormField label="کمیسیون ثابت (ریال)" hint="اختیاری؛ به صورت مبلغ ثابت به فرمول دیجی‌کالا اضافه می‌شود.">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    dir="ltr"
                    value={form.fixedCommission}
                    disabled={!canEdit || form.mode === 'margin'}
                    onChange={(event) => update('fixedCommission', event.target.value)}
                  />
                </FormField>
                <FormField label="درصد مالیات بر ارزش افزوده">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    dir="ltr"
                    value={form.vatPercent}
                    disabled={!canEdit}
                    onChange={(event) => update('vatPercent', event.target.value)}
                  />
                </FormField>
                <FormField label="گرد کردن قیمت نهایی">
                  <Select
                    options={ROUNDING_OPTIONS}
                    value={form.rounding}
                    disabled={!canEdit}
                    onChange={(event) => update('rounding', event.target.value as RoundingStep)}
                  />
                </FormField>
              </div>

              <p className="text-[11px] text-slate-400">
                {selectedPolicy?.policy.updatedAt === null || selectedPolicy?.policy.updatedAt === undefined
                  ? 'این سیاست هنوز ذخیره نشده است؛ مقادیر پیش‌فرض نمایش داده می‌شوند.'
                  : `آخرین ذخیره: ${formatJalaliDateTime(selectedPolicy.policy.updatedAt)}`}
              </p>
              {!canEdit ? (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  برای ویرایش سیاست به مجوز <span dir="ltr">channel.account.update</span> نیاز دارید.
                </p>
              ) : null}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="پیش‌نمایش زنده"
            description="یک محصول را جستجو کنید یا شناسه تنوع را وارد کنید."
            actions={<Calculator aria-hidden className="size-4 text-slate-400" />}
          />

          <div className="space-y-3">
            <FormField label="شناسه تنوع کالا (UUID)">
              <Input
                dir="ltr"
                value={variantId}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => {
                  setVariantId(event.target.value.trim());
                  setProductId('');
                }}
              />
            </FormField>

            <FormField label="جستجوی محصول" hint="نام یا شناسه کالا را وارد کنید و سپس تنوع را انتخاب کنید.">
              <Input
                value={productSearch}
                placeholder="جستجوی محصول…"
                startIcon={<Search className="size-4" />}
                onChange={(event) => {
                  setProductSearch(event.target.value);
                  setProductId('');
                  setVariantId('');
                }}
              />
            </FormField>

            {debouncedSearch.trim().length >= 2 && productId === '' ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
                {productsQuery.isLoading ? (
                  <p className="p-3 text-xs text-slate-500">در حال جستجو…</p>
                ) : productsQuery.isError ? (
                  <p className="p-3 text-xs text-red-600">{toFaErrorMessage(productsQuery.error)}</p>
                ) : (productsQuery.data?.items.length ?? 0) === 0 ? (
                  <p className="p-3 text-xs text-slate-500">محصولی یافت نشد.</p>
                ) : (
                  (productsQuery.data?.items ?? []).map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className="block w-full border-b border-slate-100 px-3 py-2 text-start text-xs last:border-0 hover:bg-brand-50 dark:border-slate-800 dark:hover:bg-slate-800"
                      onClick={() => {
                        setProductId(product.id);
                        setVariantId('');
                      }}
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-100">{product.nameFa}</span>
                      <span dir="ltr" className="ms-2 text-slate-400">{product.sku ?? ''}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}

            {productId !== '' ? (
              <FormField label="تنوع کالا">
                <Select
                  options={variants.map((variant) => ({
                    value: variant.id,
                    label: `${variant.sku}${variant.barcode === null || variant.barcode === undefined ? '' : ` · ${variant.barcode}`}`,
                  }))}
                  placeholder={variantsQuery.isLoading ? 'در حال دریافت تنوع‌ها…' : 'انتخاب تنوع'}
                  value={variantId}
                  disabled={variantsQuery.isLoading}
                  onChange={(event) => setVariantId(event.target.value)}
                />
              </FormField>
            ) : null}

            {previewQuery.isError ? (
              <ErrorState error={previewQuery.error} onRetry={() => void previewQuery.refetch()} />
            ) : previewQuery.isLoading ? (
              <p className="py-5 text-center text-xs text-slate-500">در حال محاسبه قیمت…</p>
            ) : preview === undefined ? (
              <EmptyState
                icon={<BadgeDollarSign className="size-8" />}
                title="پیش‌نمایشی وجود ندارد"
                description="پس از انتخاب حساب و تنوع کالا، قیمت پیشنهادی اینجا محاسبه می‌شود."
              />
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-950/40">
                  <p className="text-xs text-brand-800 dark:text-brand-200">قیمت پیشنهادی کانال</p>
                  <p className="mt-1 text-xl font-bold text-brand-900 dark:text-brand-100">
                    {formatMoney(preview.finalPrice)}
                  </p>
                  <p className="mt-1 text-[11px] text-brand-700/70 dark:text-brand-300/70">
                    {preview.productName ?? '—'} · <span dir="ltr">{preview.sku ?? preview.variantId}</span>
                  </p>
                </div>

                <div>
                  <BreakdownRow label="بهای خرید" value={formatMoney(preview.breakdown.cost)} />
                  <BreakdownRow
                    label={`حاشیه سود (${preview.breakdown.marginPercent}٪)`}
                    value={formatMoney(preview.breakdown.marginAmount)}
                  />
                  <BreakdownRow
                    label={`کمیسیون (${preview.breakdown.commissionPercent}٪)`}
                    value={formatMoney(preview.breakdown.commissionAmount)}
                  />
                  <BreakdownRow label="کارمزد پردازش" value={formatMoney(preview.breakdown.processingFee)} />
                  <BreakdownRow label="هزینه ارسال" value={formatMoney(preview.breakdown.shippingFee)} />
                  <BreakdownRow label="کمیسیون ثابت" value={formatMoney(preview.breakdown.fixedCommission)} />
                  <BreakdownRow label="قیمت پیش از مالیات" value={formatMoney(preview.breakdown.preVatPrice)} />
                  <BreakdownRow
                    label={`مالیات بر ارزش افزوده (${preview.breakdown.vatPercent}٪)`}
                    value={formatMoney(preview.breakdown.vatAmount)}
                  />
                  <BreakdownRow label="گرد کردن" value={formatMoney(preview.breakdown.roundingAdjustment)} />
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
