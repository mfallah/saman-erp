/**
 * One pricing policy per sales-channel account (replaces the two confusing
 * `/pricing/lists` + `/pricing/rules` menus).
 *
 * Each card saves the policy in `channel_accounts.settings.pricing`, applies it
 * to every mapped variant of that account and optionally pushes the prices to
 * the channel.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeDollarSign, Info, Save, Send } from 'lucide-react';

import { api, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  ChannelPricingAccountView,
  ChannelPricingPolicy,
  CommissionMode,
  PolicyApplyResult,
  RoundingStep,
} from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';

type PolicyCostSource = 'last_purchase' | 'moving_average';

interface PolicyForm {
  readonly costSource: PolicyCostSource;
  readonly marginPercent: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly commissionMode: CommissionMode;
  readonly commissionPercent: string;
  readonly fixedCommission: string;
  readonly vatPercent: string;
  readonly rounding: RoundingStep;
  readonly autoApply: boolean;
  readonly autoPush: boolean;
}

const COST_SOURCE_OPTIONS = [
  { value: 'last_purchase', label: 'آخرین بهای خرید' },
  { value: 'moving_average', label: 'میانگین متحرک موجودی' },
];

const COMMISSION_MODE_OPTIONS = [
  { value: 'product', label: 'کمیسیون محصول (از کانال)' },
  { value: 'percent', label: 'درصد کمیسیون ثابت' },
  { value: 'fixed', label: 'مبلغ کمیسیون ثابت (ریال)' },
];

const ROUNDING_OPTIONS = [
  { value: 'none', label: 'بدون گرد کردن' },
  { value: '500', label: 'نزدیک‌ترین ۵۰۰ ریال' },
  { value: '1000', label: 'نزدیک‌ترین ۱٬۰۰۰ ریال' },
];

function formFromPolicy(policy: ChannelPricingPolicy): PolicyForm {
  const costSource: PolicyCostSource =
    policy.costSource === 'moving_average' || policy.costSource === 'avg_cost'
      ? 'moving_average'
      : 'last_purchase';
  return {
    costSource,
    marginPercent: String(policy.marginPercent),
    processingFee: String(policy.processingFee),
    shippingFee: String(policy.shippingFee),
    commissionMode: policy.commissionMode ?? 'percent',
    commissionPercent: String(policy.commissionPercent),
    fixedCommission: String(policy.fixedCommission),
    vatPercent: String(policy.vatPercent),
    rounding: policy.rounding,
    autoApply: policy.autoApply === true,
    autoPush: policy.autoPush === true,
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

function bodyFromForm(
  form: PolicyForm,
  channelCode: string,
): Omit<ChannelPricingPolicy, 'updatedAt'> {
  return {
    // The legacy `mode` is kept in sync for the old `/pricing` screen.
    mode: channelCode === 'digikala' ? 'cost_plus_fees' : 'margin',
    costSource: form.costSource,
    marginPercent: Number(form.marginPercent),
    processingFee: Number(form.processingFee),
    shippingFee: Number(form.shippingFee),
    commissionMode: form.commissionMode,
    commissionPercent: Number(form.commissionPercent),
    fixedCommission: Number(form.fixedCommission),
    vatPercent: Number(form.vatPercent),
    rounding: form.rounding,
    autoApply: form.autoApply,
    autoPush: form.autoPush,
  };
}

function formulaText(row: ChannelPricingAccountView, form: PolicyForm): string {
  const margin = form.marginPercent === '' ? '۰' : form.marginPercent;
  if (row.channelCode !== 'digikala') {
    return `قیمت = بهای خرید × (۱ + ${margin}٪ حاشیه) + کارمزد پردازش + هزینه ارسال`;
  }
  const commission =
    form.commissionMode === 'fixed'
      ? 'کمیسیون ثابت'
      : form.commissionMode === 'product'
        ? 'کمیسیون همان محصول'
        : `${form.commissionPercent === '' ? '۰' : form.commissionPercent}٪`;
  const vat = Number(form.vatPercent) > 0 ? ' × (۱ + مالیات٪)' : '';
  const rounding = form.rounding === 'none' ? '' : ' → گرد کردن';
  return `قیمت = (بهای خرید + کارمزد پردازش + هزینه ارسال) × (۱ + ${margin}٪ حاشیه) ÷ (۱ − ${commission})${vat}${rounding}`;
}

function AccountPolicyCard({
  row,
  canEdit,
}: {
  readonly row: ChannelPricingAccountView;
  readonly canEdit: boolean;
}): ReactElement {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PolicyForm>(() => formFromPolicy(row.policy));

  useEffect(() => {
    setForm(formFromPolicy(row.policy));
  }, [row.accountId, row.policy.updatedAt]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put<ChannelPricingPolicy>(
        `/pricing/channels/${row.accountId}/policy`,
        bodyFromForm(form, row.channelCode),
      ),
    onSuccess: (policy) => {
      setForm(formFromPolicy(policy));
      toast.success('سیاست ذخیره شد', `سیاست حساب «${row.accountName}» به‌روز شد.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pricing.channels });
    },
    onError: (error) => toast.error('ذخیره سیاست ناموفق بود', toFaErrorMessage(error)),
  });

  const applyMutation = useMutation({
    mutationFn: () => api.post<PolicyApplyResult>(`/pricing/channels/${row.accountId}/apply`, {}),
    onSuccess: (result) => {
      if (result.missingCommission !== undefined && result.missingCommission > 0) {
        toast.warning(
          'قیمت‌ها اعمال شد',
          `${formatNumber(result.applied)} قیمت ذخیره شد؛ برای ${formatNumber(result.missingCommission)} کالا نرخ کمیسیون محصول ثبت نشده و درصد جایگزین اعمال شد.`,
        );
      } else if (result.pushed === 0) {
        toast.info(
          'قیمت‌ها اعمال شد',
          `${formatNumber(result.applied)} قیمت ذخیره شد. برای ارسال به کانال، «ارسال خودکار قیمت به کانال» را روشن و دوباره اعمال کنید.`,
        );
      } else {
        toast.success(
          'اعمال و ارسال انجام شد',
          `${formatNumber(result.applied)} قیمت ذخیره و ${formatNumber(result.pushed)} قیمت به کانال ارسال شد.`,
        );
      }
      if (result.pushError !== undefined) {
        toast.warning('ارسال به کانال ناموفق بود', result.pushError);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.pricing.channels });
    },
    onError: (error) => toast.error('اعمال سیاست ناموفق بود', toFaErrorMessage(error)),
  });

  const update = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = (): void => {
    const validation = validateForm(form);
    if (validation !== null) {
      toast.error('ورودی نامعتبر', validation);
      return;
    }
    saveMutation.mutate();
  };

  const isDigikala = row.channelCode === 'digikala';
  const isFixed = form.commissionMode === 'fixed';

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={row.accountName}
        description={`${row.channelName} · ${row.channelCode}`}
        actions={
          <div className="flex flex-col items-end gap-1">
            <Badge tone="info">{formatNumber(row.mappedVariants)} کالای نگاشت‌شده</Badge>
            <Badge tone={row.policy.updatedAt === null ? 'neutral' : 'success'}>
              {row.policy.updatedAt === null ? 'ذخیره‌نشده' : 'سیاست فعال'}
            </Badge>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="منبع بهای خرید" hint="مبنای محاسبه قیمت فروش.">
          <Select
            options={COST_SOURCE_OPTIONS}
            value={form.costSource}
            disabled={!canEdit}
            onChange={(event) => update('costSource', event.target.value as PolicyCostSource)}
          />
        </FormField>
        <FormField label="درصد حاشیه سود" hint="درصدی از بهای خرید که به قیمت اضافه می‌شود.">
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
        <FormField label="کارمزد پردازش (ریال)">
          <Input
            type="number"
            min="0"
            step="1"
            dir="ltr"
            value={form.processingFee}
            disabled={!canEdit}
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
            disabled={!canEdit}
            onChange={(event) => update('shippingFee', event.target.value)}
          />
        </FormField>
      </div>

      {isDigikala ? (
        <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
          <p className="flex items-start gap-1.5">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              کمیسیون دیجی‌کالا در حالت «کمیسیون محصول» برای هر کالا از
              <code dir="ltr" className="mx-1 rounded bg-white/70 px-1 dark:bg-slate-900/60">
                channel_product_costs
              </code>
              خوانده می‌شود؛ برای به‌روزرسانی، محصولات را از صفحهٔ «یکپارچه‌سازی‌ها» دوباره همگام کنید.
            </span>
          </p>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {isDigikala ? (
          <>
            <FormField label="نوع کمیسیون">
              <Select
                options={COMMISSION_MODE_OPTIONS}
                value={form.commissionMode}
                disabled={!canEdit}
                onChange={(event) => update('commissionMode', event.target.value as CommissionMode)}
              />
            </FormField>
            {isFixed ? (
              <FormField label="مبلغ کمیسیون ثابت (ریال)" hint="کمیسیون = مبلغ ثابت هر فروش.">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  dir="ltr"
                  value={form.fixedCommission}
                  disabled={!canEdit}
                  onChange={(event) => update('fixedCommission', event.target.value)}
                />
              </FormField>
            ) : (
              <FormField
                label="درصد کمیسیون"
                hint={
                  form.commissionMode === 'product'
                    ? 'فقط اگر نرخ کمیسیون محصول ثبت نشده باشد استفاده می‌شود.'
                    : 'درصدی از قیمت فروش.'
                }
              >
                <Input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  dir="ltr"
                  value={form.commissionPercent}
                  disabled={!canEdit}
                  onChange={(event) => update('commissionPercent', event.target.value)}
                />
              </FormField>
            )}
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
          </>
        ) : (
          <p className="text-[11px] text-slate-400 sm:col-span-2">
            برای کانال‌های غیر از دیجی‌کالا، مالیات و گرد کردن در فرمول اعمال نمی‌شود.
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-300"
            checked={form.autoApply}
            disabled={!canEdit}
            onChange={(event) => update('autoApply', event.target.checked)}
          />
          اعمال خودکار پس از دریافت محصولات
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-300"
            checked={form.autoPush}
            disabled={!canEdit}
            onChange={(event) => update('autoPush', event.target.checked)}
          />
          ارسال خودکار قیمت به کانال
        </label>
      </div>

      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
        پیش‌نمایش فرمول: <span dir="rtl">{formulaText(row, form)}</span>
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
        <div>
          <p className="text-slate-500 dark:text-slate-400">آخرین اعمال قیمت</p>
          <p className="mt-1 font-medium text-slate-800 dark:text-slate-100">
            {row.lastAppliedAt === null ? '—' : formatJalaliDateTime(row.lastAppliedAt)}
          </p>
        </div>
        <div>
          <p className="text-slate-500 dark:text-slate-400">آخرین ارسال به کانال</p>
          <div className="mt-1">
            {row.lastPushStatus === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <StatusBadge status={row.lastPushStatus} />
            )}
          </div>
        </div>
      </div>

      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<Save className="size-4" />} loading={saveMutation.isPending} onClick={save}>
            ذخیره سیاست
          </Button>
          <Button
            variant="outline"
            icon={<Send className="size-4" />}
            loading={applyMutation.isPending}
            onClick={() => applyMutation.mutate()}
          >
            اعمال و ارسال به کانال
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
          برای ویرایش سیاست به مجوز <span dir="ltr">pricing.rule.update</span> نیاز دارید.
        </p>
      )}
    </Card>
  );
}

export function ChannelsPricingPage(): ReactElement {
  useDocumentTitle('سیاست قیمت‌گذاری کانال‌ها');
  const canRead = useHasPermission(PERM.pricingRuleRead);
  const canEdit = useHasPermission(PERM.pricingRuleUpdate);

  const channelsQuery = useQuery({
    queryKey: queryKeys.pricing.channels,
    queryFn: () => api.get<readonly ChannelPricingAccountView[]>('/pricing/channels'),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="سیاست قیمت‌گذاری کانال‌ها" />
        <PermissionNotice permission={PERM.pricingRuleRead} />
      </>
    );
  }

  const rows = channelsQuery.data ?? [];

  return (
    <>
      <PageHeader
        title="سیاست قیمت‌گذاری کانال‌ها"
        description="یک سیاست برای هر حساب فروش؛ روی همهٔ کالاهای نگاشت‌شده اعمال و به کانال ارسال می‌شود."
        breadcrumbs={[{ label: 'قیمت‌گذاری' }, { label: 'سیاست کانال‌ها' }]}
      />

      {channelsQuery.isError ? (
        <ErrorState error={channelsQuery.error} onRetry={() => void channelsQuery.refetch()} />
      ) : channelsQuery.isLoading ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">در حال دریافت حساب‌های کانال…</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BadgeDollarSign className="size-8" />}
            title="حساب کانال فعالی یافت نشد"
            description="ابتدا در صفحهٔ یکپارچه‌سازی‌ها یک حساب فروشندهٔ فعال بسازید."
          />
        </Card>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {rows.map((row) => (
            <AccountPolicyCard key={row.accountId} row={row} canEdit={canEdit} />
          ))}
        </div>
      )}
    </>
  );
}
