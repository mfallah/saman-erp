import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Lock, MessageSquareText, Save, Trash2 } from 'lucide-react';
import { api, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime, relativeTimeFa } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { OrganizationRef } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonText } from '../components/ui/Skeleton';
import { Switch } from '../components/ui/Switch';
import { TabPanel, Tabs } from '../components/ui/Tabs';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';
import { applyFavicon } from '../lib/branding';

/** Persian labels for known setting keys; unknown keys are shown by their code. */
const SETTING_LABELS: Record<string, string> = {
  sessionIdleMinutes: 'مدت بی‌فعالیتی نشست (دقیقه)',
  passwordMinLength: 'حداقل طول رمز عبور',
  otpEnabled: 'ورود با کد یکبار مصرف',
  mfaRequired: 'الزام تأیید دومرحله‌ای',
  maxLoginAttempts: 'حداکثر تلاش ناموفق ورود',
  lockoutMinutes: 'مدت قفل حساب (دقیقه)',
  ipAllowlist: 'فهرست IP مجاز',
  smsEnabled: 'ارسال پیامک فعال',
  smsSenderNumber: 'شماره فرستنده پیامک',
  otpPatternId: 'شناسه الگوی OTP',
  emailEnabled: 'ارسال ایمیل فعال',
  quietHoursFrom: 'شروع ساعات عدم ارسال',
  quietHoursTo: 'پایان ساعات عدم ارسال',
  defaultTaxRateId: 'شناسه نرخ مالیات پیش‌فرض',
  allowNegativeStock: 'اجازه موجودی منفی',
  autoConfirmOrders: 'تأیید خودکار سفارش‌ها',
  priceRoundingMode: 'روش گرد کردن قیمت',
  defaultPriceListId: 'فهرست قیمت پیش‌فرض',
  commissionRate: 'نرخ کمیسیون',
  version: 'نسخه',
};

interface SessionRow {
  readonly id: string;
  readonly deviceLabel?: string;
  readonly ip?: string;
  readonly lastUsedAt?: string;
  readonly createdAt?: string;
  readonly current?: boolean;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

interface GroupEditorProps {
  readonly group: string;
  readonly title: string;
  readonly description?: string;
  readonly editable: boolean;
}

/**
 * Generic settings-group editor. The API exposes groups as opaque validated
 * objects (API.md §4.17); fields rendered here are exactly what the server
 * returns, with Persian labels for known keys. Values are sent back through
 * `PUT /settings/{group}` with `If-Match` — no client-side invention.
 */
function SettingsGroupEditor({ group, title, description, editable }: GroupEditorProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: queryKeys.settings.group(group),
    queryFn: () => api.get<Record<string, unknown>>(`/settings/${group}`),
  });

  useEffect(() => {
    if (query.data !== undefined) {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(query.data)) {
        if (isPrimitive(value)) {
          next[key] = String(value);
        }
      }
      setValues(next);
    }
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const version = query.data?.['version'];
      return api.put<Record<string, unknown>>(
        `/settings/${group}`,
        values,
        { ...(typeof version === 'number' ? { ifMatch: version } : {}) },
      );
    },
    onSuccess: () => {
      toast.success('تنظیمات ذخیره شد');
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.group(group) });
    },
    onError: (error) => toast.error('ذخیره تنظیمات ناموفق بود', toFaErrorMessage(error)),
  });

  const fields = Object.keys(values);
  const nested = useMemo(
    () => Object.entries(query.data ?? {}).filter(([, value]) => !isPrimitive(value) && value !== null),
    [query.data],
  );

  return (
    <Card>
      <CardHeader
        title={title}
        {...(description === undefined ? {} : { description })}
        actions={
          <Button
            icon={<Save className="size-4" />}
            loading={saveMutation.isPending}
            disabled={!editable || fields.length === 0}
            onClick={() => saveMutation.mutate()}
          >
            ذخیره
          </Button>
        }
      />
      {query.isLoading ? (
        <SkeletonText lines={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : fields.length === 0 ? (
        <EmptyState
          title="تنظیماتی برای این گروه ثبت نشده است"
          description="پس از تعریف تنظیمات در سرویس، فیلدها در این بخش قابل ویرایش می‌شوند."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {fields.map((key) => {
            const label = SETTING_LABELS[key] ?? key;
            const value = values[key] ?? '';
            const toggle = value === 'true' || value === 'false';
            return (
              <FormField key={key} label={label} hint={SETTING_LABELS[key] === undefined ? key : undefined}>
                {toggle ? (
                  <Switch
                    label={value === 'true' ? 'فعال' : 'غیرفعال'}
                    checked={value === 'true'}
                    disabled={!editable}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [key]: event.target.checked ? 'true' : 'false' }))
                    }
                  />
                ) : value.length > 60 ? (
                  <Textarea
                    rows={2}
                    value={value}
                    disabled={!editable}
                    onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                  />
                ) : (
                  <Input
                    dir="ltr"
                    className="text-left"
                    value={value}
                    disabled={!editable}
                    onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                  />
                )}
              </FormField>
            );
          })}
        </div>
      )}
      {nested.length > 0 && (
        <div className="mt-3 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500 dark:bg-slate-800">
          <p className="mb-1 font-medium">ساختارهای تودرتو (فقط خواندنی در این نمای کلی):</p>
          <pre dir="ltr" className="overflow-x-auto text-start">
            {JSON.stringify(Object.fromEntries(nested), null, 2)}
          </pre>
        </div>
      )}
    </Card>
  );
}

function OrganizationTab({ editable }: { readonly editable: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.settings.organization,
    queryFn: () => api.get<OrganizationRef & Record<string, unknown>>('/organization'),
  });
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (query.data !== undefined) {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(query.data)) {
        if (isPrimitive(value)) {
          next[key] = String(value);
        }
      }
      setForm(next);
    }
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: () => {
      const version = query.data?.['version'];
      return api.patch<Record<string, unknown>>(
        '/organization',
        {
          legalName: form['legalName'],
          nationalId: form['nationalId'],
          phone: form['phone'],
          email: form['email'],
          address: form['address'],
        },
        { ...(typeof version === 'number' ? { ifMatch: version } : {}) },
      );
    },
    onSuccess: () => {
      toast.success('اطلاعات سازمان ذخیره شد');
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.organization });
    },
    onError: (error) => toast.error('ذخیره اطلاعات سازمان ناموفق بود', toFaErrorMessage(error)),
  });

  const known = ['legalName', 'nationalId', 'phone', 'email', 'address'] as const;
  const labels: Record<(typeof known)[number], string> = {
    legalName: 'نام حقوقی سازمان',
    nationalId: 'شناسه ملی',
    phone: 'تلفن',
    email: 'ایمیل',
    address: 'نشانی',
  };

  return (
    <Card>
      <CardHeader
        title="پروفایل سازمان"
        description="اطلاعات حقوقی و تماس سازمان"
        actions={
          <Button
            icon={<Save className="size-4" />}
            loading={mutation.isPending}
            disabled={!editable || query.isError}
            onClick={() => mutation.mutate()}
          >
            ذخیره
          </Button>
        }
      />
      {query.isLoading ? (
        <SkeletonText lines={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {known.map((key) => (
            <FormField key={key} label={labels[key]} {...(key === 'address' ? { className: 'md:col-span-2' } : {})}>
              {key === 'address' ? (
                <Textarea
                  rows={2}
                  value={form[key] ?? ''}
                  disabled={!editable}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                />
              ) : (
                <Input
                  dir={key === 'email' || key === 'nationalId' ? 'ltr' : undefined}
                  className={key === 'email' || key === 'nationalId' ? 'text-left' : undefined}
                  value={form[key] ?? ''}
                  disabled={!editable}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                />
              )}
            </FormField>
          ))}
        </div>
      )}
    </Card>
  );
}

function SessionsCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.auth.sessions,
    queryFn: () => api.getPage<SessionRow>('/auth/sessions', { limit: 20, include: 'revoked' }),
  });
  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => api.del(`/auth/sessions/${sessionId}`),
    onSuccess: () => {
      toast.success('نشست بسته شد');
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.sessions });
    },
    onError: (error) => toast.error('بستن نشست ناموفق بود', toFaErrorMessage(error)),
  });

  return (
    <Card>
      <CardHeader title="نشست‌های فعال" description="دستگاه‌هایی که به حساب شما وارد شده‌اند" />
      {query.isLoading ? (
        <SkeletonText lines={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (query.data?.items ?? []).length === 0 ? (
        <p className="text-xs text-slate-500">نشست فعالی یافت نشد.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(query.data?.items ?? []).map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-2 py-2 text-xs">
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {session.deviceLabel ?? 'دستگاه ناشناس'}
                  {session.current === true && (
                    <Badge tone="success" className="ms-2">
                      این دستگاه
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-slate-400">
                  {session.ip ?? '—'} ·{' '}
                  {session.lastUsedAt === undefined ? '—' : relativeTimeFa(session.lastUsedAt)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-3.5" />}
                loading={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(session.id)}
              >
                بستن
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}


/** Upload logo/favicon and store them as data URLs in settings group `branding`. */
function BrandingTab({ editable }: { readonly editable: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [logo, setLogo] = useState<string | undefined>(undefined);
  const [favicon, setFavicon] = useState<string | undefined>(undefined);
  const [appName, setAppName] = useState('');

  const query = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<{ items: readonly { key: string; value: unknown }[] }>('/settings/branding'),
    retry: false,
  });

  useEffect(() => {
    if (query.data === undefined) return;
    const map = new Map(query.data.items.map((item) => [item.key, item.value]));
    const pick = (key: string): string | undefined => {
      const value = map.get(key);
      if (typeof value !== 'string') return undefined;
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'string' ? parsed : value;
      } catch {
        return value;
      }
    };
    setLogo(pick('branding.logo'));
    setFavicon(pick('branding.favicon'));
    setAppName(pick('branding.app_name') ?? '');
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put<Record<string, unknown>>('/settings/branding', {
        'branding.logo': logo ?? '',
        'branding.favicon': favicon ?? '',
        'branding.app_name': appName,
      }),
    onSuccess: () => {
      toast.success('برندینگ ذخیره شد');
      applyFavicon(favicon ?? logo);
      void queryClient.invalidateQueries({ queryKey: ['branding'] });
    },
    onError: (error) => toast.error('ذخیره برندینگ ناموفق بود', toFaErrorMessage(error)),
  });

  const pick = (file: File | undefined, apply: (value: string | undefined) => void) => {
    if (file === undefined) return;
    if (file.size > 200 * 1024) {
      toast.error('فایل بزرگ است', 'حجم لوگو/فاوآیکون باید کمتر از ۲۰۰ کیلوبایت باشد.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => apply(typeof reader.result === 'string' ? reader.result : undefined);
    reader.readAsDataURL(file);
  };

  return (
    <Card>
      <CardHeader title="برندینگ" description="لوگو، فاوآیکون و نام نمایشی سامانه" />
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="لوگو (PNG/SVG، حداکثر ۲۰۰KB)">
          <div className="flex items-center gap-3">
            {logo === undefined ? null : <img src={logo} alt="لوگو" className="size-12 rounded-lg object-contain" />}
            <input
              type="file"
              accept="image/png,image/svg+xml,image/webp"
              disabled={!editable}
              onChange={(event) => pick(event.target.files?.[0], setLogo)}
              className="block w-full text-xs"
            />
          </div>
        </FormField>
        <FormField label="فاوآیکون (PNG/ICO/SVG)">
          <div className="flex items-center gap-3">
            {favicon === undefined ? null : <img src={favicon} alt="فاوآیکون" className="size-8 rounded object-contain" />}
            <input
              type="file"
              accept="image/png,image/svg+xml,image/x-icon,image/webp"
              disabled={!editable}
              onChange={(event) => pick(event.target.files?.[0], setFavicon)}
              className="block w-full text-xs"
            />
          </div>
        </FormField>
        <FormField label="نام نمایشی سامانه">
          <Input value={appName} disabled={!editable} onChange={(event) => setAppName(event.target.value)} placeholder="سامان ERP" />
        </FormField>
      </div>
      {editable ? (
        <div className="mt-4">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            ذخیره برندینگ
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500">برای ویرایش برندینگ به مجوز تنظیمات نیاز دارید.</p>
      )}
    </Card>
  );
}

/** Settings: organization, SMS, pricing and security groups. */
export function SettingsPage() {
  useDocumentTitle('تنظیمات');
  const canRead = useHasPermission(PERM.settingRead);
  const canUpdate = useHasPermission(PERM.settingUpdate);
  const [tab, setTab] = useState('organization');

  if (!canRead) {
    return (
      <>
        <PageHeader title="تنظیمات" />
        <PermissionNotice permission={PERM.settingRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="تنظیمات"
        description="پیکربندی سازمان، پیامک، قیمت‌گذاری و امنیت"
        breadcrumbs={[{ label: 'تنظیمات' }]}
        actions={
          canUpdate ? (
            <Badge tone="success">اجازه ویرایش دارید</Badge>
          ) : (
            <Badge tone="neutral">دسترسی فقط خواندن</Badge>
          )
        }
      />

      <Tabs
        ariaLabel="گروه‌های تنظیمات"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'organization', label: 'سازمان', icon: <Building2 className="size-4" /> },
          { value: 'sms', label: 'پیامک', icon: <MessageSquareText className="size-4" /> },
          { value: 'pricing', label: 'قیمت‌گذاری' },
          { value: 'branding', label: 'برندینگ' },
          { value: 'security', label: 'امنیت', icon: <Lock className="size-4" /> },
        ]}
      />

      <TabPanel value={tab}>
        {tab === 'organization' && <OrganizationTab editable={canUpdate} />}
        {tab === 'sms' && (
          <div className="space-y-4">
            <SettingsGroupEditor
              group="notifications"
              title="تنظیمات اطلاع‌رسانی"
              description="ارسال پیامک، ایمیل و ساعات عدم ارسال"
              editable={canUpdate}
            />
            <div className="rounded-xl border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-700">
              الگوهای پیامک (Limo) و گزارش ارسال‌ها از طریق APIهای sms-templates و sms-messages مدیریت می‌شوند؛
              این بخش در نسخه بعدی رابط کاربری کامل خواهد داشت.
            </div>
          </div>
        )}
        {tab === 'pricing' && (
          <SettingsGroupEditor
            group="sales"
            title="تنظیمات فروش و قیمت‌گذاری"
            description="قواعد قیمت‌گذاری، مالیات پیش‌فرض و کمیسیون"
            editable={canUpdate}
          />
        )}
        {tab === 'branding' && <BrandingTab editable={canUpdate} />}
        {tab === 'security' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsGroupEditor
              group="security"
              title="سیاست‌های امنیتی"
              description="نشست، رمز عبور و تأیید دومرحله‌ای"
              editable={canUpdate}
            />
            <SessionsCard />
            <Card className="lg:col-span-2">
              <CardHeader title="تغییر رمز عبور" description="رمز عبور جدید باید با سیاست امنیتی سازمان سازگار باشد." />
              <p className="text-xs text-slate-500">
                تغییر رمز عبور نیازمند تأیید هویت مجدد (Step-up) است و از مسیر اختصاصی امنیتی انجام می‌شود. برای
                انجام این کار با مدیر سامانه تماس بگیرید یا از صفحه‌های تأیید هویت استفاده کنید.
              </p>
              <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-400">
                <Lock aria-hidden className="size-3.5" />
                همه نشست‌های دیگر پس از تغییر رمز بسته می‌شوند.
              </p>
            </Card>
          </div>
        )}
      </TabPanel>

      <p className="mt-4 flex items-center gap-1 text-[11px] text-slate-400">
        <Badge tone="info">نکته</Badge>
        آخرین بازخوانی تنظیمات: {formatJalaliDateTime(new Date())}
      </p>
    </>
  );
}
