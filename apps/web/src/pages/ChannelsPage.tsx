import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, KeyRound, PlugZap, RefreshCw, RotateCw, Upload } from 'lucide-react';
import { ApiError, api, isNotImplemented, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime, relativeTimeFa } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  Channel,
  ChannelAccount,
  ChannelAccountRsaKeypair,
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
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

const SYNC_TYPES = [
  { value: 'inventory_push', label: 'ارسال موجودی' },
  { value: 'price_push', label: 'ارسال قیمت' },
  { value: 'order_pull', label: 'دریافت سفارش‌ها' },
  { value: 'product_import', label: 'دریافت محصولات از کانال (اولین همگام‌سازی)' },
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
  const canWriteCredentials = useHasPermission(PERM.credentialWrite);
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
  const [rsaAccount, setRsaAccount] = useState<ChannelAccount | null>(null);
  const [rsaPublicKey, setRsaPublicKey] = useState('');
  const [rsaFingerprint, setRsaFingerprint] = useState('');
  const [rsaHasPrivateKey, setRsaHasPrivateKey] = useState(false);
  const [rsaPrivateKeyInput, setRsaPrivateKeyInput] = useState('');
  const [rsaImportOpen, setRsaImportOpen] = useState(false);
  const [rsaBusy, setRsaBusy] = useState(false);
  const [rsaLoading, setRsaLoading] = useState(false);
  const [rsaError, setRsaError] = useState('');
  const [dkClientCode, setDkClientCode] = useState('');
  const [dkClientSecret, setDkClientSecret] = useState('');
  const [dkValidationCode, setDkValidationCode] = useState('');
  const [dkBusy, setDkBusy] = useState(false);
  const [dkResult, setDkResult] = useState('');

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

  const activateDigikala = async (): Promise<void> => {
    if (rsaAccount === null) return;
    setDkBusy(true);
    setDkResult('');
    try {
      const result = await api.post<{ ok: boolean; decryption: string; expiresIn?: number | null; hasRefreshToken?: boolean }>(
        `/channel-accounts/${rsaAccount.id}/digikala/token`,
        { validationCode: dkValidationCode, clientCode: dkClientCode, clientSecret: dkClientSecret },
        { idempotencyKey: newRequestId() },
      );
      setDkResult(
        `توکن دریافت شد (${result.decryption}) — ${result.hasRefreshToken ? 'refresh token ذخیره شد' : 'بدون refresh token'}${result.expiresIn ? ` · انقضا ${result.expiresIn} ثانیه` : ''}`,
      );
      toast.success('توکن دیجی‌کالا فعال شد');
      setDkValidationCode('');
    } catch (error) {
      setDkResult(toFaErrorMessage(error));
      toast.error('فعال‌سازی توکن ناموفق بود', toFaErrorMessage(error));
    } finally {
      setDkBusy(false);
    }
  };

  const loadRsaKeypair = async (account: ChannelAccount): Promise<void> => {
    setRsaLoading(true);
    try {
      const view = await api.get<ChannelAccountRsaKeypair>(
        `/channel-accounts/${account.id}/rsa-keypair`,
      );
      setRsaPublicKey(view.publicKeyPem);
      setRsaFingerprint(view.fingerprint);
      setRsaHasPrivateKey(view.hasPrivateKey === true);
      setRsaError('');
    } catch (error) {
      setRsaPublicKey('');
      setRsaFingerprint('');
      setRsaHasPrivateKey(false);
      setRsaError(error instanceof ApiError && error.code === 'NOT_FOUND' ? '' : toFaErrorMessage(error));
    } finally {
      setRsaLoading(false);
    }
  };

  const openRsaModal = (account: ChannelAccount): void => {
    setRsaAccount(account);
    setRsaPublicKey('');
    setRsaFingerprint('');
    setRsaHasPrivateKey(false);
    setRsaPrivateKeyInput('');
    setRsaImportOpen(false);
    setRsaError('');
    void loadRsaKeypair(account);
  };

  const saveRsaKeypair = async (privateKeyPem?: string): Promise<void> => {
    if (rsaAccount === null) return;
    setRsaBusy(true);
    setRsaError('');
    try {
      const result = await api.post<ChannelAccountRsaKeypair>(
        `/channel-accounts/${rsaAccount.id}/rsa-keypair`,
        privateKeyPem === undefined ? {} : { privateKeyPem },
        { idempotencyKey: newRequestId() },
      );
      setRsaPublicKey(result.publicKeyPem);
      setRsaFingerprint(result.fingerprint);
      setRsaHasPrivateKey(true);
      setRsaPrivateKeyInput('');
      setRsaImportOpen(false);
      toast.success('کلید RSA ذخیره شد', 'کلید عمومی را در پنل دیجی‌کالا ثبت کنید.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.accounts(selectedChannelId) });
    } catch (error) {
      const message = toFaErrorMessage(error);
      setRsaError(message);
      toast.error('ثبت کلید RSA ناموفق بود', message);
    } finally {
      setRsaBusy(false);
    }
  };

  const copyPublicKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(rsaPublicKey);
      toast.success('کلید عمومی کپی شد');
    } catch {
      setRsaError('کپی خودکار ممکن نشد؛ متن کلید را دستی انتخاب و کپی کنید.');
    }
  };

  const readPrivateKeyFile = async (file: File): Promise<void> => {
    try {
      setRsaPrivateKeyInput(await file.text());
      setRsaError('');
    } catch {
      setRsaError('خواندن فایل کلید ناموفق بود.');
    }
  };

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
      render: (account) => (
        <div className="flex flex-wrap gap-2">
          {canWriteCredentials ? (
            <Button
              size="sm"
              variant="outline"
              icon={<KeyRound className="size-3.5" />}
              onClick={() => openRsaModal(account)}
            >
              کلید RSA
            </Button>
          ) : null}
          {canTest ? (
            <Button
              size="sm"
              variant="outline"
              icon={<FlaskConical className="size-3.5" />}
              loading={testAccountMutation.isPending}
              onClick={() => testAccountMutation.mutate(account.id)}
            >
              آزمایش اتصال
            </Button>
          ) : null}
        </div>
      ),
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
        open={rsaAccount !== null}
        onClose={() => setRsaAccount(null)}
        title="کلید RSA دیجی‌کالا"
        description={
          rsaAccount === null
            ? undefined
            : `حساب: ${rsaAccount.nameFa ?? rsaAccount.name ?? rsaAccount.id}`
        }
        footer={
          <Button variant="outline" onClick={() => setRsaAccount(null)}>
            بستن
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            کلید عمومی (PEM) را در پنل دیجی‌کالا، بخش احراز هویت فروشنده، جای‌گذاری کنید. کلید
            خصوصی فقط به‌صورت رمزنگاری‌شده در سرور نگهداری می‌شود و هرگز نمایش داده نمی‌شود.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<KeyRound className="size-3.5" />}
              loading={rsaBusy && !rsaImportOpen}
              disabled={rsaBusy || rsaLoading}
              onClick={() => void saveRsaKeypair()}
            >
              تولید جفت‌کلید
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<Upload className="size-3.5" />}
              disabled={rsaBusy || rsaLoading}
              onClick={() => setRsaImportOpen((value) => !value)}
            >
              بارگذاری کلید خصوصی
            </Button>
          </div>

          {rsaImportOpen ? (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <FormField
                label="کلید خصوصی (PEM)"
                hint="فایل .pem یا متن PKCS#8 / PKCS#1 رمزنگاری‌نشده را وارد کنید."
              >
                <Textarea
                  dir="ltr"
                  rows={6}
                  className="font-mono text-[11px]"
                  value={rsaPrivateKeyInput}
                  onChange={(event) => setRsaPrivateKeyInput(event.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </FormField>
              <input
                type="file"
                accept=".pem,.key,.txt,text/plain"
                className="block w-full text-xs text-slate-500 file:me-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void readPrivateKeyFile(file);
                }}
              />
              <Button
                size="sm"
                loading={rsaBusy}
                disabled={rsaPrivateKeyInput.trim().length === 0}
                onClick={() => void saveRsaKeypair(rsaPrivateKeyInput)}
              >
                ذخیره کلید خصوصی
              </Button>
            </div>
          ) : null}

          {rsaError.length > 0 ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {rsaError}
            </p>
          ) : null}

          {rsaLoading ? (
            <p className="text-xs text-slate-500">در حال خواندن کلید عمومی…</p>
          ) : rsaPublicKey.length > 0 ? (
            <div className="space-y-2">
              <FormField label="کلید عمومی (PEM)" hint="این مقدار را کپی و در پنل دیجی‌کالا ثبت کنید.">
                <Textarea
                  dir="ltr"
                  readOnly
                  rows={9}
                  className="font-mono text-[11px]"
                  value={rsaPublicKey}
                />
              </FormField>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Copy className="size-3.5" />}
                  onClick={() => void copyPublicKey()}
                >
                  کپی کلید عمومی
                </Button>
                <Badge tone={rsaHasPrivateKey ? 'success' : 'warning'}>
                  {rsaHasPrivateKey ? 'کلید خصوصی ذخیره شده است' : 'کلید خصوصی ثبت نشده است'}
                </Badge>
              </div>
              <p dir="ltr" className="break-all font-mono text-[10px] text-slate-500">
                SHA-256: {rsaFingerprint}
              </p>

              <div className="mt-4 space-y-2 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  فعال‌سازی توکن دیجی‌کالا
                </p>
                <p className="text-[11px] text-slate-500">
                  از پنل دیجی‌کالا «کد کلاینت» و «کد اعتبارسنجی» را کپی کن و اینجا بچسبان؛ سامانه کد را
                  با کلید خصوصی رمزگشایی و به توکن تبدیل می‌کند.
                </p>
                <Input
                  dir="ltr"
                  placeholder="Client code"
                  value={dkClientCode}
                  onChange={(event) => setDkClientCode(event.target.value)}
                />
                <Input
                  dir="ltr"
                  type="password"
                  placeholder="Client secret (اگر دیجی‌کالا داده)"
                  value={dkClientSecret}
                  onChange={(event) => setDkClientSecret(event.target.value)}
                />
                <Textarea
                  dir="ltr"
                  rows={4}
                  placeholder="Validation code (base64)"
                  className="font-mono text-[11px]"
                  value={dkValidationCode}
                  onChange={(event) => setDkValidationCode(event.target.value)}
                />
                <Button
                  size="sm"
                  loading={dkBusy}
                  disabled={dkValidationCode.trim().length === 0 || !rsaHasPrivateKey}
                  onClick={() => void activateDigikala()}
                >
                  تبدیل کد به توکن
                </Button>
                {dkResult === '' ? null : <p className="text-[11px] text-slate-600 dark:text-slate-300">{dkResult}</p>}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              هنوز کلید RSA برای این حساب ثبت نشده است؛ جفت‌کلید بسازید یا کلید خصوصی موجود را
              بارگذاری کنید.
            </p>
          )}
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
