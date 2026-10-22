import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, PlugZap, RefreshCw, RotateCw } from 'lucide-react';
import { api, isNotImplemented, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime, relativeTimeFa } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  Channel,
  ChannelAccount,
  ChannelHealthRow,
  SyncJob,
} from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Combobox } from '../components/ui/Combobox';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { TabPanel, Tabs } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

const SYNC_TYPES = [
  { value: 'inventory_push', label: 'ارسال موجودی' },
  { value: 'price_push', label: 'ارسال قیمت' },
  { value: 'order_pull', label: 'دریافت سفارش‌ها' },
  { value: 'product_push', label: 'ارسال محصولات' },
  { value: 'settlement_pull', label: 'دریافت تسویه' },
  { value: 'full_reconcile', label: 'همگام‌سازی کامل' },
];

const healthColumns: readonly Column<ChannelHealthRow>[] = [
  { key: 'channel', header: 'کانال', render: (row) => row.channel?.nameFa ?? row.channel?.name ?? '—' },
  { key: 'account', header: 'حساب', render: (row) => row.account?.name ?? '—' },
  {
    key: 'status',
    header: 'وضعیت',
    render: (row) => (
      <Badge tone={(row.failureStreak ?? 0) > 0 ? 'warning' : 'success'}>
        {row.status ?? ((row.failureStreak ?? 0) > 0 ? 'نیازمند بررسی' : 'سالم')}
      </Badge>
    ),
  },  {
    key: 'lastSuccessAt',
    header: 'آخرین موفقیت',
    render: (row) => (row.lastSuccessAt === undefined || row.lastSuccessAt === null ? '—' : relativeTimeFa(row.lastSuccessAt)),
  },
  {
    key: 'failureStreak',
    header: 'خطای پیاپی',
    align: 'end',
    render: (row) => formatNumber(row.failureStreak ?? 0),
  },
  { key: 'rateLimit', header: 'محدودیت نرخ', render: (row) => row.rateLimitState ?? '—' },
];

const jobColumns: readonly Column<SyncJob>[] = [
  { key: 'type', header: 'نوع', render: (job) => <Badge tone="info">{job.type}</Badge> },
  { key: 'channel', header: 'کانال', render: (job) => job.channel?.nameFa ?? job.channel?.name ?? '—' },
  {
    key: 'status',
    header: 'وضعیت',
    render: (job) => <StatusBadge status={job.status} />,
  },
  {
    key: 'progress',
    header: 'پیشرفت',
    align: 'end',
    render: (job) =>
      job.progress === undefined
        ? '—'
        : `${formatNumber(job.progress.processed ?? 0)} / ${formatNumber(job.progress.total ?? 0)}`,
  },
  {
    key: 'createdAt',
    header: 'زمان',
    render: (job) => (job.createdAt === undefined ? '—' : formatJalaliDateTime(job.createdAt)),
  },
];

/** Channel accounts, sync jobs and integration health. */
export function ChannelsPage() {
  useDocumentTitle('یکپارچه‌سازی‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.channelRead);
  const canSync = useHasPermission(PERM.syncTrigger);
  const canTest = useHasPermission(PERM.accountTest);
  const [tab, setTab] = useState('health');
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [syncOpen, setSyncOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [syncType, setSyncType] = useState('inventory_push');

  const channelsQuery = useQuery({
    queryKey: queryKeys.channels.list,
    queryFn: () => api.get<readonly Channel[]>('/channels', { perPage: 100 }),
    enabled: canRead,
    staleTime: 5 * 60_000,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.channels.health,
    queryFn: () => api.get<readonly ChannelHealthRow[]>('/channels/health'),
    enabled: canRead && tab === 'health',
  });
  const accountsQuery = useQuery({
    queryKey: queryKeys.channels.accounts(selectedChannelId),
    queryFn: () => api.get<readonly ChannelAccount[]>(`/channels/${selectedChannelId}/accounts`, { perPage: 100 }),
    enabled: canRead && tab === 'accounts' && selectedChannelId !== '',
  });
  const jobsQuery = useQuery({
    queryKey: queryKeys.channels.syncJobs({ tab }),
    queryFn: () => api.getPage<SyncJob>('/channel-sync-jobs', { limit: 25 }),
    enabled: canRead && tab === 'jobs',
  });

  const channels = channelsQuery.data ?? [];
  const channelOptions = channels.map((channel) => ({
    value: channel.id,
    label: channel.nameFa ?? channel.name ?? channel.code,
  }));

  const triggerSyncMutation = useMutation({
    mutationFn: () =>
      api.post<SyncJob>(
        '/channel-sync-jobs',
        { channelId: selectedChannelId, type: syncType },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('همگام‌سازی در صف قرار گرفت', 'نتیجه در فهرست کارهای همگام‌سازی قابل پیگیری است.');
      setSyncOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['channel-sync-jobs'] });
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'این نوع همگام‌سازی هنوز فعال نشده است.');
      } else {
        toast.error('شروع همگام‌سازی ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post<SyncJob>(`/channel-sync-jobs/${jobId}/retry`, {}),
    onSuccess: () => {
      toast.success('تلاش مجدد در صف قرار گرفت');
      void queryClient.invalidateQueries({ queryKey: ['channel-sync-jobs'] });
    },
    onError: (error) => toast.error('تلاش مجدد ناموفق بود', toFaErrorMessage(error)),
  });

  const createAccountMutation = useMutation({
    mutationFn: () => {
      const credentials: Record<string, string> = {};
      if (apiKey.trim().length > 0) credentials['api_key'] = apiKey.trim();
      if (apiSecret.trim().length > 0) credentials['api_secret'] = apiSecret.trim();
      if (webhookSecret.trim().length > 0) credentials['webhook_secret'] = webhookSecret.trim();
      return api.post<{ id: string; credentialsStored: readonly string[] }>(
        `/channels/${selectedChannelId}/accounts`,
        {
          name: accountName.trim(),
          externalAccountId: externalAccountId.trim() || undefined,
          credentials,
        },
        { idempotencyKey: newRequestId() },
      );
    },
    onSuccess: (result) => {
      toast.success('حساب کانال ساخته شد', `کلیدهای ذخیره‌شده: ${result.credentialsStored.join('، ') || 'بدون کلید'}`);
      setAccountOpen(false);
      setAccountName('');
      setExternalAccountId('');
      setApiKey('');
      setApiSecret('');
      setWebhookSecret('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.accounts(selectedChannelId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.list });
    },
    onError: (error) => toast.error('ساخت حساب ناموفق بود', toFaErrorMessage(error)),
  });

  const testAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.post<{ ok?: boolean; latencyMs?: number }>(`/channel-accounts/${accountId}/test`, {}),
    onSuccess: (result) => {
      if (result.ok === false) {
        toast.warning('اتصال ناموفق', 'تنظیمات اعتبارنامه کانال را بررسی کنید.');
      } else {
        toast.success(
          'اتصال موفق',
          result.latencyMs === undefined ? undefined : `زمان پاسخ: ${formatNumber(result.latencyMs)} میلی‌ثانیه`,
        );
      }
    },
    onError: (error) => toast.error('آزمایش اتصال ناموفق بود', toFaErrorMessage(error)),
  });

  const accountColumns: readonly Column<ChannelAccount>[] = [
    { key: 'name', header: 'حساب', render: (account) => account.nameFa ?? account.name ?? '—' },
    { key: 'external', header: 'شناسه فروشنده', render: (account) => <span dir="ltr">{account.externalSellerId ?? '—'}</span> },
    {
      key: 'active',
      header: 'وضعیت',
      render: (account) => (
        <Badge tone={account.active === false ? 'neutral' : 'success'}>
          {account.active === false ? 'غیرفعال' : 'فعال'}
        </Badge>
      ),
    },
    {
      key: 'credential',
      header: 'اعتبارنامه',
      render: (account) =>
        account.credentialMeta === undefined
          ? '—'
          : `••••${account.credentialMeta.last4 ?? ''}`,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (account) =>
        canTest ? (
          <Button
            size="sm"
            variant="outline"
            icon={<FlaskConical className="size-3.5" />}
            loading={testAccountMutation.isPending}
            onClick={() => testAccountMutation.mutate(account.id)}
          >
            آزمایش اتصال
          </Button>
        ) : null,
    },
  ];

  if (!canRead) {
    return (
      <>
        <PageHeader title="یکپارچه‌سازی‌ها" />
        <PermissionNotice permission={PERM.channelRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="یکپارچه‌سازی‌ها"
        description="کانال‌های فروش، حساب‌های فروشنده، همگام‌سازی و وضعیت سلامت"
        actions={
          canSync ? (
            <Button icon={<RotateCw className="size-4" />} onClick={() => setSyncOpen(true)} disabled={channels.length === 0}>
              اجرای همگام‌سازی
            </Button>
          ) : undefined
        }
      />

      <Tabs
        ariaLabel="بخش‌های یکپارچه‌سازی"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'health', label: 'سلامت کانال‌ها' },
          { value: 'accounts', label: 'کانال‌ها و حساب‌ها' },
          { value: 'jobs', label: 'کارهای همگام‌سازی' },
        ]}
      />

      <TabPanel value={tab}>
        {tab === 'health' && (
          <>
            {healthQuery.isError ? (
              <ErrorState error={healthQuery.error} onRetry={() => void healthQuery.refetch()} />
            ) : (
              <DataTable
                columns={healthColumns}
                rows={healthQuery.data ?? []}
                rowKey={(row) => row.id ?? `${row.channel?.id ?? ''}-${row.account?.id ?? ''}`}
                loading={healthQuery.isLoading}
                caption="سلامت کانال‌ها"
                emptyTitle="کانالی تنظیم نشده است"
                emptyDescription="برای اتصال به کانال‌های فروش، ابتدا یک کانال را فعال کنید."
              />
            )}
          </>
        )}

        {tab === 'accounts' && (
          <Card>
            <CardHeader title="حساب‌های فروشنده" description="اعتبارنامه‌ها هرگز به‌صورت متن کامل نمایش داده نمی‌شوند." />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-500">کلیدهای دیجی‌کالا / کِرَکسی اینجا ذخیره و رمزنگاری می‌شوند.</span>
              <Button size="sm" disabled={selectedChannelId === ''} onClick={() => setAccountOpen(true)}>
                افزودن حساب و کلیدها
              </Button>
            </div>
            <div className="mb-3 max-w-sm">
              <Combobox
                options={channelOptions}
                value={selectedChannelId}
                loading={channelsQuery.isLoading}
                placeholder="انتخاب کانال"
                ariaLabel="انتخاب کانال"
                onChange={(value) => setSelectedChannelId(value)}
              />
            </div>
            {selectedChannelId === '' ? (
              <EmptyState
                icon={<PlugZap className="size-8" />}
                title="کانالی انتخاب نشده است"
                description="برای مشاهده حساب‌های فروشنده، یک کانال انتخاب کنید."
              />
            ) : accountsQuery.isError ? (
              <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
            ) : (
              <DataTable
                columns={accountColumns}
                rows={accountsQuery.data ?? []}
                rowKey={(account) => account.id}
                loading={accountsQuery.isLoading}
                caption="حساب‌های کانال"
                emptyTitle="حسابی برای این کانال ثبت نشده است"
              />
            )}
          </Card>
        )}

        {tab === 'jobs' && (
          <>
            {jobsQuery.isError ? (
              <ErrorState error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />
            ) : (
              <DataTable
                columns={[
                  ...jobColumns,
                  {
                    key: 'actions',
                    header: 'عملیات',
                    render: (job) =>
                      job.status === 'failed' || job.status === 'partial' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={retryMutation.isPending}
                          onClick={() => retryMutation.mutate(job.id)}
                        >
                          تلاش مجدد
                        </Button>
                      ) : null,
                  },
                ]}
                rows={jobsQuery.data?.items ?? []}
                rowKey={(job) => job.id}
                loading={jobsQuery.isLoading}
                caption="کارهای همگام‌سازی"
                emptyTitle="کاری ثبت نشده است"
                emptyDescription="پس از اجرای همگام‌سازی، وضعیت کارها در این بخش قابل پیگیری است."
              />
            )}
            <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-400">
              <RefreshCw aria-hidden className="size-3.5" />
              همگام‌سازی‌ها به‌صورت غیرهم‌زمان در پس‌زمینه اجرا می‌شوند.
            </p>
          </>
        )}
      </TabPanel>

      <Modal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title="افزودن حساب کانال"
        footer={
          <>
            <Button variant="outline" onClick={() => setAccountOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={createAccountMutation.isPending}
              disabled={accountName.trim().length === 0}
              onClick={() => createAccountMutation.mutate()}
            >
              ذخیره حساب
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="نام حساب" required>
            <Input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="مثلاً فروشگاه دیجی‌کالا" />
          </FormField>
          <FormField label="شناسه فروشنده / Seller ID">
            <Input dir="ltr" value={externalAccountId} onChange={(event) => setExternalAccountId(event.target.value)} />
          </FormField>
          <FormField label="API Key">
            <Input dir="ltr" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </FormField>
          <FormField label="API Secret">
            <Input dir="ltr" type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} />
          </FormField>
          <FormField label="Webhook Secret (اختیاری)">
            <Input dir="ltr" type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        title="اجرای همگام‌سازی"
        footer={
          <>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={triggerSyncMutation.isPending}
              disabled={selectedChannelId === ''}
              onClick={() => triggerSyncMutation.mutate()}
            >
              اجرا
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="کانال" required>
            <Select
              options={channelOptions}
              placeholder="انتخاب کانال"
              value={selectedChannelId}
              onChange={(event) => setSelectedChannelId(event.target.value)}
            />
          </FormField>
          <FormField label="نوع همگام‌سازی" required>
            <Select options={SYNC_TYPES} value={syncType} onChange={(event) => setSyncType(event.target.value)} />
          </FormField>
        </div>
      </Modal>
    </>
  );
}
